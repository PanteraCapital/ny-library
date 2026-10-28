'use strict'

const fs = require('fs')
const path = require('path')
const {JSDOM, VirtualConsole} = require('jsdom')
const request = require('supertest')
const {expect} = require('chai')
const sinon = require('sinon')

const app = require('../../server/index')
const {getDocsInfo, getTree} = require('../../server/list')
const {cleanName, pathPrefix} = require('../../server/utils')

// Same file the pages load: layouts/partials/head.ejs pins jquery 3.2.1.
const jquerySource = fs.readFileSync(path.join(__dirname, '../vendor/jquery-3.2.1.js'), 'utf8')
const mainSource = fs.readFileSync(path.join(__dirname, '../../public/scripts/main.js'), 'utf8')
const headSource = fs.readFileSync(path.join(__dirname, '../../layouts/partials/head.ejs'), 'utf8')

const userInfo = {
  emails: [{value: 'test.user@test.com'}],
  id: '10',
  userId: '10',
  _json: {domain: 'test.com'}
}

// Payloads have no "." so server/utils.js cleanName does not treat a suffix as a file extension.
const DOC_NAME = '<img class="docxss" src="x" onerror="window[\'docxss\']=1">'
const FOLDER_NAME = '<script>window[\'folderxss\']=1</script>'
const MOST_VIEWED_NAME = '<script>window[\'mostxss\']=1</script>'
const TEAM_NAME = '<img class="teamxss" src="x" onerror="window[\'teamxss\']=1"><script>window[\'teamscript\']=1</script> | team'
const DOC_PATH = '/safe"><script>window[\'docpathxss\']=1</script>'
const TEAM_PATH = '/safe"><script>window[\'teampathxss\']=1</script>'

const saved = []

function remember(obj, key, value) {
  saved.push({obj, key, previous: obj[key]})
  obj[key] = value
}

function meta(id) {
  const found = getDocsInfo()[id]
  if (!found) throw new Error('missing drive metadata for ' + id)
  return found
}

function renderedFormatUrl() {
  const match = headSource.match(/function formatUrl\(url\) \{[\s\S]*?\n {6}\}/)
  if (!match) throw new Error('formatUrl was not found in layouts/partials/head.ejs')
  // ejs substitutes pathPrefix into the quoted return. Keep the rest of the function verbatim.
  return match[0].replace('<%= pathPrefix %>', pathPrefix)
}

function installAjax(window) {
  const $ = window.$
  window.$.ajax = function (urlOrSettings, maybeSettings) {
    const settings = typeof urlOrSettings === 'string'
      ? Object.assign({url: urlOrSettings}, maybeSettings)
      : urlOrSettings
    const deferred = $.Deferred()
    let url = settings.url
    if (settings.data) {
      const qs = new URLSearchParams(settings.data).toString()
      url += (url.includes('?') ? '&' : '?') + qs
    }
    request(app)
      .get(url)
      .set('Accept', 'application/json')
      .then((res) => {
        if (res.status !== 200) {
          deferred.reject(new Error(url + ' returned ' + res.status + ' ' + res.text))
          return
        }
        if (typeof settings.success === 'function') settings.success(res.body)
        deferred.resolve(res.body, 'success')
      })
      .catch((err) => deferred.reject(err))
    return deferred
  }
}

async function loadLibraryPage() {
  const res = await request(app).get('/').set('Accept', 'text/html')
  expect(res.status).to.equal(200)
  const html = res.text.replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://library.test/',
    virtualConsole: new VirtualConsole()
  })
  const {window} = dom
  window.eval(jquerySource)
  window.eval(renderedFormatUrl())
  window.$.fn.typeahead = function () { return this }
  installAjax(window)
  window.localStorage.removeItem('libraryHistory:victim:teams')
  window.localStorage.removeItem('libraryHistory:victim:docs')
  window.eval(mainSource)
  await new Promise((resolve) => setTimeout(resolve, 30))
  return window
}

async function waitFor(fn, label) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < 5000) {
    try {
      if (fn()) return
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''))
}

async function openHistoryMenu(window) {
  window.$('.user-tools').trigger('mouseover')
  await waitFor(() => window.document.querySelector('#me .popup h3'), 'reading history menu')
}

async function personalizeTeams(window) {
  window.personalizeHomepage('victim')
  await waitFor(() => window.localStorage.getItem('libraryHistory:victim:teams'), 'homepage team history')
}

describe('Drive names inserted into browser HTML', () => {
  beforeEach(async () => {
    await getTree()
    sinon.stub(app.request, 'session').value({passport: {user: userInfo}})
  })

  afterEach(() => {
    while (saved.length) {
      const {obj, key, previous} = saved.pop()
      obj[key] = previous
    }
    sinon.restore()
  })

  it('escapes a document pretty name in the page heading', async () => {
    const doc = meta('Test5')
    remember(doc, 'prettyName', cleanName(DOC_NAME))

    const res = await request(app).get(doc.path).set('Accept', 'text/html')
    expect(res.status).to.equal(200)

    const dom = new JSDOM(res.text, {url: 'http://library.test/'})
    const headline = dom.window.document.querySelector('h1.headline')
    expect(headline).to.not.equal(null)
    expect(headline.textContent).to.include(cleanName(DOC_NAME))
    expect(dom.window.document.querySelector('img.docxss')).to.equal(null)
    expect(dom.window.docxss).to.equal(undefined)
  })

  it('does not run a document pretty name from the user-menu history', async () => {
    const doc = meta('Test5')
    remember(doc, 'prettyName', cleanName(DOC_NAME))

    const window = await loadLibraryPage()
    await openHistoryMenu(window)

    const popup = window.document.querySelector('#me .popup')
    expect(window.docxss).to.equal(undefined)
    expect(popup.querySelector('img.docxss')).to.equal(null)
    expect(popup.textContent).to.include(cleanName(DOC_NAME))
  })

  it('does not run a parent folder pretty name from the user-menu history', async () => {
    const doc = meta('Test5')
    expect(doc.folder).to.be.an('object')
    remember(doc.folder, 'prettyName', cleanName(FOLDER_NAME))

    const window = await loadLibraryPage()
    await openHistoryMenu(window)

    const popup = window.document.querySelector('#me .popup')
    expect(window.folderxss).to.equal(undefined)
    expect(popup.querySelector('script')).to.equal(null)
    expect(popup.textContent).to.include(cleanName(FOLDER_NAME))
  })

  it('does not run a most-viewed document pretty name from the user-menu history', async () => {
    const doc = meta('Test4')
    remember(doc, 'prettyName', cleanName(MOST_VIEWED_NAME))

    const window = await loadLibraryPage()
    await openHistoryMenu(window)

    const popup = window.document.querySelector('#me .popup')
    expect(window.mostxss).to.equal(undefined)
    expect(popup.textContent).to.include(cleanName(MOST_VIEWED_NAME))
  })

  it('does not run a document path from the user-menu history href', async () => {
    const doc = meta('Test5')
    remember(doc, 'path', DOC_PATH)

    const window = await loadLibraryPage()
    await openHistoryMenu(window)

    const popup = window.document.querySelector('#me .popup')
    expect(window.docpathxss).to.equal(undefined)
    expect(popup.querySelector('script')).to.equal(null)
    const hrefs = Array.from(popup.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'))
    expect(hrefs.some((href) => href && href.indexOf('<') !== -1)).to.equal(false)
  })

  it('does not run a team pretty name when the homepage asks for team history', async () => {
    const team = meta('TestFolder9')
    const pretty = cleanName(TEAM_NAME)
    remember(team, 'prettyName', pretty)

    const window = await loadLibraryPage()
    // The rendered list uses the module tag, not the selector personalizeHomepage writes to.
    expect(window.document.querySelector('ul.team-cat-list')).to.not.equal(null)
    expect(window.document.querySelector('ul.teams-cat-list')).to.equal(null)

    await personalizeTeams(window)

    const stored = JSON.parse(window.localStorage.getItem('libraryHistory:victim:teams'))
    const names = stored.history.mostViewed.map((entry) => entry.team.prettyName)
    expect(names).to.include(pretty)
    const list = window.document.querySelector('ul.team-cat-list')
    expect(window.teamxss).to.equal(undefined)
    expect(window.teamscript).to.equal(undefined)
    expect(list.querySelector('img.teamxss')).to.equal(null)
    expect(list.querySelector('script')).to.equal(null)
    expect(list.innerHTML).to.not.include('<img')
    expect(list.innerHTML).to.not.include('<script')
    expect(list.textContent).to.include(pretty)
  })

  it('does not run a team path when the homepage asks for team history', async () => {
    const team = meta('TestFolder9')
    remember(team, 'path', TEAM_PATH)

    const window = await loadLibraryPage()
    await personalizeTeams(window)

    const stored = JSON.parse(window.localStorage.getItem('libraryHistory:victim:teams'))
    const paths = stored.history.mostViewed.map((entry) => entry.team.path)
    expect(paths).to.include(TEAM_PATH)
    expect(window.teampathxss).to.equal(undefined)
    expect(window.document.querySelector('script')).to.equal(null)
  })
})
