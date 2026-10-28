/**
 * @jest-environment node
 */
'use strict'

const path = require('path')
const {google} = require('googleapis')
const {GoogleAuth} = require('google-auth-library')
const xlsx = require('xlsx')
const request = require('supertest')
const cheerio = require('cheerio')
const {expect} = require('chai')
const sinon = require('sinon')

// Attacker-controlled Drive bytes. The sentinel is unique to this payload so
// the application's own inline scripts (footer analytics, date formatting)
// are not treated as the finding.
const ATTACK_HTML = [
  '<!DOCTYPE html><html><head><title>notes</title></head><body>',
  '<h1>Visible heading</h1>',
  '<p>Hello <a href="https://example.com/ok">safe link</a></p>',
  '<script>window.__xssmarker=1</script>',
  '<img src="x" onerror="window.__xssmarker=1">',
  '<a href="javascript:window.__xssmarker=1">bad</a>',
  '<a href="JaVaScRiPt:window.__xssmarker=1">bad</a>',
  '<iframe src="https://evil.example/xssmarker"></iframe>',
  '<p onclick="window.__xssmarker=1">clicky</p>',
  '<svg onload="window.__xssmarker=1"></svg>',
  '</body></html>'
].join('')

// Excel and SheetJS reject sheet names that contain : \ / ? * [ ].
// A name can still introduce an img handler or an opening script tag.
const SHEET_NAMES = [
  'x<img src=x onerror=alert(1)>',
  '<script>alert(1)'
]

const DRIVE_ID = process.env.DRIVE_ID

function driveFile (fields) {
  return Object.assign({
    parents: [DRIVE_ID],
    webViewLink: `https://drive.google.com/file/d/${fields.id}`,
    createdTime: '2018-01-01T00:00:00.000Z',
    modifiedTime: '2018-01-02T00:00:00.000Z',
    lastModifyingUser: {displayName: 'Content Author'}
  }, fields)
}

function buildSheetBuffer () {
  const wb = xlsx.utils.book_new()
  for (const name of SHEET_NAMES) {
    const ws = xlsx.utils.aoa_to_sheet([['safe-cell']])
    xlsx.utils.book_append_sheet(wb, ws, name)
  }
  return xlsx.write(wb, {type: 'buffer', bookType: 'xlsx'})
}

function installDrive () {
  const sheetBuf = buildSheetBuffer()
  const files = [
    driveFile({
      id: 'folder-docs',
      name: 'Docs',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_ID]
    }),
    driveFile({
      id: 'file-html',
      name: 'Attacker Notes',
      mimeType: 'text/html',
      parents: ['folder-docs']
    }),
    driveFile({
      id: 'file-sheet',
      name: 'Attacker Sheet',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['folder-docs']
    }),
    driveFile({
      id: 'file-gdoc',
      name: 'Exported Doc',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-docs']
    }),
    driveFile({
      id: 'file-playlist',
      name: 'Attacker Playlist | playlist',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['folder-docs']
    }),
    driveFile({
      id: 'file-playlist-doc',
      name: 'Inside Playlist',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-docs']
    })
  ]

  GoogleAuth.prototype.getClient = async () => ({})
  google.options = () => {}
  google.drive = () => ({
    files: {
      list: () => ({data: {files}}),
      export: ({mimeType}) => {
        if (mimeType && mimeType.includes('spreadsheetml')) return {data: sheetBuf}
        return {data: ATTACK_HTML}
      },
      get: () => ({data: ATTACK_HTML})
    },
    revisions: {
      get: () => Promise.resolve({
        data: {
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2018-01-02T00:00:00.000Z',
          lastModifyingUser: {displayName: 'Content Author'}
        }
      })
    }
  })
  google.sheets = () => ({
    spreadsheets: {
      values: {
        get: () => ({
          data: {
            values: [
              ['link'],
              ['https://docs.google.com/document/d/file-playlist-doc/edit']
            ]
          }
        })
      }
    }
  })
}

function reloadApp () {
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key]
  })
  return require('../../server/index')
}

function assertNoAttackerMarkup (html) {
  const $ = cheerio.load(html)
  $('script').each((i, el) => {
    const body = `${$(el).html() || ''}${$(el).attr('src') || ''}`
    expect(body, 'script').to.not.match(/xssmarker|alert\s*\(/i)
  })
  $('*').each((i, el) => {
    const attribs = el.attribs || {}
    for (const [name, value] of Object.entries(attribs)) {
      expect(name, `${el.name || el.tagName} attribute`).to.not.match(/^on/i)
      const text = String(value)
      expect(text, `${el.name || el.tagName} ${name}`).to.not.match(/^\s*javascript:/i)
      expect(text, `${el.name || el.tagName} ${name}`).to.not.include('xssmarker')
      expect(text, `${el.name || el.tagName} ${name}`).to.not.include('evil.example')
    }
  })
  expect($('iframe').length, 'iframe').to.equal(0)
}

function assertSafeDocument (html) {
  assertNoAttackerMarkup(html)
  expect(html).to.include('Visible heading')
  expect(html).to.include('https://example.com/ok')
}

async function walkableUrl (id) {
  const {getTree} = require('../../server/list')
  const tree = await getTree()
  const visit = (node, prefix) => {
    if (node.id === id) return prefix || '/'
    const children = node.children || {}
    for (const [slug, child] of Object.entries(children)) {
      const found = visit(child, `${prefix}/${slug}`)
      if (found) return found
    }
    return null
  }
  return visit(tree, '')
}

installDrive()
const app = reloadApp()

const victim = {
  emails: [{value: 'victim@test.com'}],
  id: '10',
  userId: '10',
  _json: {domain: 'test.com'}
}

describe('stored Drive HTML', () => {
  beforeEach(() => sinon.stub(app.request, 'session').value({passport: {user: victim}}))
  afterEach(() => sinon.restore())

  it('does not render active content from an uploaded text/html file', async () => {
    const url = await walkableUrl('file-html')
    expect(url, 'text/html file is a supported library page').to.be.a('string')

    const page = await request(app).get(url)
    expect(page.status, page.text.slice(0, 800)).to.equal(200)
    expect(page.text).to.include('g-main-content')
    const whoami = await request(app).get('/whoami.json')
    expect(whoami.status).to.equal(200)
    expect(whoami.body.email).to.equal('test.user@test.com')
    assertSafeDocument(page.text)
  })

  it('does not render active content from a Google Doc HTML export', async () => {
    const url = await walkableUrl('file-gdoc')
    expect(url, 'document is a supported library page').to.be.a('string')

    const page = await request(app).get(url)
    expect(page.status, page.text.slice(0, 800)).to.equal(200)
    assertSafeDocument(page.text)
  })

  it('does not render a spreadsheet sheet name as markup', async () => {
    const {getMeta, getTree} = require('../../server/list')
    await getTree()
    const meta = getMeta('file-sheet')
    expect(meta.resourceType).to.equal('spreadsheet')

    const url = await walkableUrl('file-sheet')
    // Removing the file from the tree is a fix. Leaving the slug and rendering
    // the workbook is also a fix when the sheet name cannot become markup.
    if (!url) return

    const page = await request(app).get(url)
    expect(page.status, page.text.slice(0, 800)).to.be.below(500)
    assertNoAttackerMarkup(page.text)
  })

  it('does not render active content in a playlist leaf', async () => {
    const {getMeta, getTree} = require('../../server/list')
    await getTree()
    const playlist = getMeta('file-playlist')
    const doc = getMeta('file-playlist-doc')
    expect(playlist.tags).to.include('playlist')
    const url = `${playlist.path}/${doc.slug}`

    const page = await request(app).get(url)
    expect(page.status, page.text.slice(0, 800)).to.equal(200)
    expect(page.text).to.include('playlist-page')
    assertSafeDocument(page.text)
  })

  it('strips active content reintroduced when inline code unescape is enabled', () => {
    process.env.ALLOW_INLINE_CODE = 'true'
    const formatterPath = require.resolve('../../server/formatter')
    delete require.cache[formatterPath]
    try {
      const {getProcessedDocAttributes} = require('../../server/formatter')
      const src = '<p>Visible heading</p><p>&lt;%- <script>window.__xssmarker=1</script> %&gt;</p>' +
        '<p>&lt;%-<img src=x onerror=alert(1)>%&gt;</p>' +
        '<p>&lt;%- <a href="javascript:alert(1)">x</a> %&gt;</p>' +
        '<p>&lt;%- <iframe src="https://evil.example/xssmarker"></iframe> %&gt;</p>'

      const {html} = getProcessedDocAttributes([src, {data: {lastModifyingUser: {displayName: 'Content Author'}}}])
      assertNoAttackerMarkup(html)
      expect(html).to.include('Visible heading')
    } finally {
      delete process.env.ALLOW_INLINE_CODE
      delete require.cache[formatterPath]
    }
  })
})
