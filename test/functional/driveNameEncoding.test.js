'use strict'

const {expect} = require('chai')
const cheerio = require('cheerio')
const request = require('supertest')

// Names a Drive editor can store. The duplicate payload has a single dot so
// cleanName's trailing-suffix strip collapses it onto the sibling slug while
// the raw name is what the warning prints. None of these strings contain a
// second dot, which is the suffix pattern cleanName removes.
const DUP_NAME = '<img src=x id=dupxss onerror="window[\'document\'][\'title\']=\'DUP\'">'
const DUP_FILE = `Report.${DUP_NAME}`
const FOLDER_NAME = '<img src=x id=folderxss onerror="window[\'document\'][\'title\']=\'FOLDER\'">'
const EDITOR_NAME = '<img src=x id=editorxss onerror="window[\'document\'][\'title\']=\'EDITOR\'">'

const userInfo = {
  emails: [{value: 'test.user@test.com'}],
  id: '10',
  userId: '10',
  _json: {domain: 'test.com'}
}

const DRIVE_ID = process.env.DRIVE_ID

function driveFile(fields) {
  return {
    createdTime: '2020-01-01T00:00:00.000Z',
    modifiedTime: '2020-01-02T00:00:00.000Z',
    webViewLink: `https://drive.google.com/file/d/${fields.id}/view`,
    lastModifyingUser: {displayName: 'Pat Editor'},
    ...fields
  }
}

// Listing order is the order produceTree pushes children. The plain "Report"
// file is first, so the second file's raw name is what lands on duplicates.
const reportsFolder = driveFile({
  id: 'folder-reports',
  name: 'Reports',
  mimeType: 'application/vnd.google-apps.folder',
  parents: [DRIVE_ID]
})
const plainReport = driveFile({
  id: 'doc-report',
  name: 'Report',
  mimeType: 'application/vnd.google-apps.document',
  parents: [reportsFolder.id]
})
const poisonedReport = driveFile({
  id: 'doc-report-poison',
  name: DUP_FILE,
  mimeType: 'application/vnd.google-apps.document',
  parents: [reportsFolder.id]
})
const poisonedFolder = driveFile({
  id: 'folder-poison',
  name: FOLDER_NAME,
  mimeType: 'application/vnd.google-apps.folder',
  parents: [DRIVE_ID]
})
const notesInPoisonedFolder = driveFile({
  id: 'doc-notes',
  name: 'Notes',
  mimeType: 'application/vnd.google-apps.document',
  parents: [poisonedFolder.id],
  lastModifyingUser: {displayName: EDITOR_NAME}
})

const listedFiles = [
  reportsFolder,
  plainReport,
  poisonedReport,
  poisonedFolder,
  notesInPoisonedFolder
]

function installDriveMock() {
  const {google} = require('googleapis')
  const {Datastore} = require('@google-cloud/datastore')

  google.options = () => {}
  google.drive = () => ({
    files: {
      list: async (options = {}) => {
        const query = options.q || ''
        if (query.includes('fullText contains')) {
          return {data: {files: [notesInPoisonedFolder]}}
        }
        return {data: {files: listedFiles}}
      },
      export: async () => ({
        data: '<html><body><p>Document body</p></body></html>'
      }),
      get: async () => ({data: '<p>Document body</p>'})
    },
    revisions: {
      get: async () => ({
        data: {
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2020-01-02T00:00:00.000Z',
          lastModifyingUser: {displayName: 'Pat Editor'}
        }
      })
    }
  })

  Datastore.prototype.key = () => ({})
  Datastore.prototype.get = async () => [{}]
  Datastore.prototype.upsert = async () => true
  Datastore.prototype.runQuery = async () => [[]]
}

describe('Drive names rendered into HTML', () => {
  let app
  let cleanName
  let slugify

  beforeAll(async () => {
    jest.resetModules()
    installDriveMock()

    const express = require('express')
    express.request.isAuthenticated = () => true
    express.request.user = userInfo
    express.request.userInfo = userInfo

    app = require('../../server/index')
    ;({cleanName, slugify} = require('../../server/utils'))
    const list = require('../../server/list')
    await list.getTree()
  })

  beforeEach(() => {
    app.request.session = {passport: {user: userInfo}}
  })

  function expectTextNotMarkup(html, selector, raw) {
    const $ = cheerio.load(html)
    expect($(selector).length, `${selector} must not be parsed as an element in ${html}`).to.equal(0)
    expect($.root().text(), 'the Drive name must still be visible as text').to.include(raw)
  }

  it('prints a duplicate file name as text on the page that shares its slug', async () => {
    // The suffix strip is what makes the two files share a slug. The warning
    // still receives the raw second name from the tree.
    expect(cleanName(DUP_FILE)).to.equal(cleanName('Report'))
    expect(slugify(cleanName(DUP_FILE))).to.equal(slugify('Report'))

    const folderSlug = slugify(cleanName(reportsFolder.name))
    const pageSlug = slugify(cleanName('Report'))
    const res = await request(app)
      .get(`/${folderSlug}/${pageSlug}`)
      .expect(200)

    expectTextNotMarkup(res.text, '#dupxss', DUP_FILE)
    const $ = cheerio.load(res.text)
    expect($('.warning').text()).to.include(DUP_FILE)
  })

  it('prints a folder name and an editor display name as text in search results', async () => {
    expect(cleanName(FOLDER_NAME)).to.equal(FOLDER_NAME)

    const res = await request(app)
      .get('/search')
      .query({q: 'Notes'})
      .expect(200)

    expectTextNotMarkup(res.text, '#folderxss', FOLDER_NAME)
    expectTextNotMarkup(res.text, '#editorxss', EDITOR_NAME)

    const $ = cheerio.load(res.text)
    expect($('a.folder').text()).to.include(FOLDER_NAME)
    expect($('span.author').text()).to.include(EDITOR_NAME)
  })
})
