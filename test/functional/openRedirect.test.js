'use strict'
/**
 * @jest-environment node
 *
 * Request paths must not become redirect targets on another host.
 * These tests fail while that is still possible. A same-origin path that
 * fails the redirect check is sent to the site root instead.
 */
const http = require('http')
const {expect} = require('chai')
const nock = require('nock')
const express = require('express')
const passportRequest = require('passport/lib/http/request')
const app = require('../../server/index')

const LIBRARY_ORIGIN = 'https://library.example'
const SITE_ROOT = '/'

const authorizedUser = {
  emails: [{value: 'test.user@test.com'}],
  id: '10',
  userId: '10'
}

function resolvedHost (location) {
  return new URL(location, LIBRARY_ORIGIN + '/').host
}

function cookieHeader (setCookie) {
  if (!setCookie) return ''
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  return list.map((value) => value.split(';')[0]).join('; ')
}

// superagent treats a path of //host as an absolute URL, so the request-target
// is sent with Node's HTTP client exactly as the attacker would send it.
function requestPath (path, headers) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => app(req, res))
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address()
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: headers || {}
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            setCookie: res.headers['set-cookie'],
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      })
      req.setTimeout(4000, () => {
        req.destroy(new Error(`timed out requesting ${path}`))
      })
      req.on('error', (err) => {
        server.close()
        reject(err)
      })
      req.end()
    })
  })
}

function mockGoogle () {
  nock.cleanAll()
  nock.disableNetConnect()
  nock.enableNetConnect('127.0.0.1')
  nock('https://www.googleapis.com')
    .post('/oauth2/v4/token')
    .reply(200, {access_token: 'tok', token_type: 'Bearer'})
  nock('https://www.googleapis.com')
    .get('/oauth2/v3/userinfo')
    .query(true)
    .reply(200, {
      sub: '10',
      email: 'test.user@test.com',
      email_verified: true,
      name: 'Test User'
    })
}

function expectSameOriginRoot (res) {
  expect(res.status).to.equal(302)
  expect(res.location).to.equal(SITE_ROOT)
  expect(resolvedHost(res.location)).to.equal('library.example')
}

describe('request paths used as redirects', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  describe('trailing-slash handler for an authenticated session', () => {
    beforeEach(() => {
      express.request.isAuthenticated = () => true
      express.request.user = authorizedUser
      app.request.session = {passport: {user: authorizedUser}}
    })

    afterEach(() => {
      delete app.request.session
    })

    it('strips one trailing slash from a same-origin path', async () => {
      const res = await requestPath('/docs/guide/')
      expect(res.status).to.equal(302)
      expect(res.location).to.equal('/docs/guide')
      expect(resolvedHost(res.location)).to.equal('library.example')
    })

    it('sends //evil.example/ to the site root', async () => {
      const res = await requestPath('//evil.example/')
      expectSameOriginRoot(res)
    })

    it('sends //evil.example/phish/ to the site root', async () => {
      const res = await requestPath('//evil.example/phish/')
      expectSameOriginRoot(res)
    })

    it('sends ///evil.example/ to the site root', async () => {
      const res = await requestPath('///evil.example/')
      expectSameOriginRoot(res)
    })

    it('sends a userinfo authority //library.example@evil.example/ to the site root', async () => {
      const res = await requestPath('//library.example@evil.example/')
      expectSameOriginRoot(res)
    })

    // The route decodes the capture before redirecting. A check of the raw
    // request-target still lets this Location leave the host.
    it('sends a percent-encoded slash prefix to the site root', async () => {
      const res = await requestPath('/%2f%2fevil.example/')
      expectSameOriginRoot(res)
    })

    it('keeps a backslash suffix on the library host', async () => {
      const res = await requestPath('/\\evil.example/')
      expect(res.status).to.equal(302)
      expect(resolvedHost(res.location)).to.equal('library.example')
      expect(res.location.startsWith('//')).to.equal(false)
    })
  })

  describe('post-login authRedirect for a logged-out session', () => {
    beforeEach(() => {
      express.request.user = undefined
      express.request.isAuthenticated = passportRequest.isAuthenticated
      delete app.request.session
    })

    async function finishLogin (attackPath) {
      mockGoogle()
      const started = await requestPath(attackPath)
      expect(started.status).to.equal(302)
      expect(started.location).to.equal('/login')
      expect(resolvedHost(started.location)).to.equal('library.example')
      return requestPath('/auth/redirect?code=test-code', {
        cookie: cookieHeader(started.setCookie)
      })
    }

    it('returns the browser to the same-origin path that started login', async () => {
      const res = await finishLogin('/docs/guide')
      expect(res.status).to.equal(302)
      expect(res.location).to.equal('/docs/guide')
      expect(resolvedHost(res.location)).to.equal('library.example')
    })

    it('drops //evil.example and finishes login at the site root', async () => {
      const res = await finishLogin('//evil.example')
      expectSameOriginRoot(res)
    })

    it('drops //evil.example/ and finishes login at the site root', async () => {
      const res = await finishLogin('//evil.example/')
      expectSameOriginRoot(res)
    })

    it('drops //evil.example/phish and finishes login at the site root', async () => {
      const res = await finishLogin('//evil.example/phish')
      expectSameOriginRoot(res)
    })

    it('drops ///evil.example and finishes login at the site root', async () => {
      const res = await finishLogin('///evil.example')
      expectSameOriginRoot(res)
    })
  })
})
