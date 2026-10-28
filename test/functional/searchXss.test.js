'use strict'

const request = require('supertest')
const {expect} = require('chai')
const sinon = require('sinon')
const cheerio = require('cheerio')
const {google} = require('googleapis')

const app = require('../../server/index')
const list = require('../../server/list')

const userInfo = {
  emails: [{value: 'test.user@test.com'}],
  id: '10',
  userId: '10',
  _json: {domain: 'test.com'}
}

// Closes the search heading and inserts a script. The string templates wrap the
// query in quotes, so the leading quote is part of the breakout.
const QUERY_PAYLOAD = '\'</h3><script data-xss="reflected-search">fetch(\'/whoami.json\')</script>'
const FOLDER_PAYLOAD = 'Home</span></a><script data-xss="search-folder"></script><span>'
const PERSON_PAYLOAD = 'Editor</span><script data-xss="search-person"></script><span>'

describe('Search page HTML encoding', () => {
  beforeEach(() => {
    sinon.stub(app.request, 'session').value({passport: {user: userInfo}})
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('query string', () => {
    it('encodes q in the empty-results heading', async () => {
      stubDriveList([])

      const res = await request(app)
        .get('/search')
        .query({q: QUERY_PAYLOAD})
        .expect(200)
        .expect('Content-Type', /html/)

      expectEncodedIn(res.text, 'reflected-search', 'h3.search-kicker')
      expect(res.text).to.include('There are no results for')
    })

    it('encodes q in the results heading when matches are returned', async () => {
      const doc = searchableDocument()
      stubDriveList([{id: doc.id}])

      const res = await request(app)
        .get('/search')
        .query({q: QUERY_PAYLOAD})
        .expect(200)
        .expect('Content-Type', /html/)

      expectEncodedIn(res.text, 'reflected-search', 'h3.search-kicker')
      expect(res.text).to.include('Showing results for')
    })
  })

  describe('search result metadata rendered by the same unescaped templates', () => {
    let doc
    let originalFolderName
    let originalDisplayName

    beforeEach(() => {
      doc = searchableDocument()
      originalFolderName = doc.folder.prettyName
      originalDisplayName = doc.lastModifyingUser.displayName
      doc.folder.prettyName = FOLDER_PAYLOAD
      doc.lastModifyingUser.displayName = PERSON_PAYLOAD
      stubDriveList([{id: doc.id}])
    })

    afterEach(() => {
      if (!doc) return
      doc.folder.prettyName = originalFolderName
      doc.lastModifyingUser.displayName = originalDisplayName
    })

    it('encodes the folder name inside the result label', async () => {
      const res = await request(app)
        .get('/search')
        .query({q: 'article'})
        .expect(200)

      expectEncodedIn(res.text, 'search-folder', '.search-result')
    })

    it('encodes the last editor name inside the result label', async () => {
      const res = await request(app)
        .get('/search')
        .query({q: 'article'})
        .expect(200)

      expectEncodedIn(res.text, 'search-person', '.search-result')
    })
  })
})

function stubDriveList(files) {
  sinon.stub(google, 'drive').callsFake(() => ({
    files: {
      list: async () => ({data: {files}})
    }
  }))
}

function searchableDocument() {
  const doc = Object.values(list.getDocsInfo()).find((item) => {
    return item &&
      item.resourceType === 'document' &&
      item.path &&
      item.path.split('/')[1] !== 'trash' &&
      item.folder &&
      item.folder.prettyName &&
      item.folder.path &&
      item.lastModifyingUser &&
      item.lastModifyingUser.displayName &&
      !(item.tags || []).includes('hidden')
  })

  if (!doc) throw new Error('No searchable document in the test drive index')
  return doc
}

function expectEncodedIn(html, marker, selector) {
  const $ = cheerio.load(html)
  const injected = $(`script[data-xss="${marker}"]`)
  expect(injected, `response must not parse a ${marker} script element`).to.have.length(0)
  expect(html, `response must not contain a raw ${marker} script tag`).to.not.include(`<script data-xss="${marker}"`)
  // Text content decodes entities, so an encoded payload still shows up here,
  // while a payload that was dropped from this region does not.
  expect($(selector).text(), `${selector} must still show the ${marker} value as text`).to.include(`data-xss="${marker}"`)
}
