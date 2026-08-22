import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

const MAX_OFFICE_DOCUMENT_BYTES = 256 * 1024 * 1024
const MAX_MARKER_PART_BYTES = 4 * 1024 * 1024

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the Office-authored QA lane`)
  return value
}

if (process.platform !== 'darwin') {
  throw new Error('The Office-authored QA lane requires macOS and real Microsoft Office output')
}

const excelPath = requiredEnvironment('GENOFFICE_OFFICE_EXCEL_OUTPUT')
const powerpointPath = requiredEnvironment('GENOFFICE_OFFICE_POWERPOINT_OUTPUT')
const wordPath = requiredEnvironment('GENOFFICE_OFFICE_WORD_OUTPUT')
const evidenceDir = requiredEnvironment('GENOFFICE_OFFICE_REOPEN_EVIDENCE')
const excelMarker = requiredEnvironment('GENOFFICE_OFFICE_EXCEL_MARKER')
const powerpointMarker = requiredEnvironment('GENOFFICE_OFFICE_POWERPOINT_MARKER')
const wordMarker = requiredEnvironment('GENOFFICE_OFFICE_WORD_MARKER')

for (const [name, marker] of [
  ['GENOFFICE_OFFICE_EXCEL_MARKER', excelMarker],
  ['GENOFFICE_OFFICE_POWERPOINT_MARKER', powerpointMarker],
  ['GENOFFICE_OFFICE_WORD_MARKER', wordMarker],
]) {
  if (marker.trim() !== marker || marker.length > 512) {
    throw new Error(`${name} must be a trimmed marker of at most 512 characters`)
  }
}

for (const [name, value] of [
  ['GENOFFICE_OFFICE_EXCEL_OUTPUT', excelPath],
  ['GENOFFICE_OFFICE_POWERPOINT_OUTPUT', powerpointPath],
  ['GENOFFICE_OFFICE_WORD_OUTPUT', wordPath],
  ['GENOFFICE_OFFICE_REOPEN_EVIDENCE', evidenceDir],
]) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
}

function pptxEntry(presentationPath: string, entry: string): string {
  return execFileSync('unzip', ['-p', presentationPath, entry], {
    maxBuffer: MAX_MARKER_PART_BYTES,
    timeout: 10_000,
  }).toString()
}

function xlsxMarkerParts(workbookPath: string): string {
  return execFileSync(
    'unzip',
    ['-p', workbookPath, 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'],
    { maxBuffer: MAX_MARKER_PART_BYTES, timeout: 10_000 },
  ).toString()
}

function docxMarkerParts(documentPath: string): string {
  return execFileSync('unzip', ['-p', documentPath, 'word/document.xml', 'word/footnotes.xml'], {
    maxBuffer: MAX_MARKER_PART_BYTES,
    timeout: 10_000,
  }).toString()
}

test.describe('Office-authored documents reopen in CodexOffice', () => {
  test.beforeAll(async () => {
    for (const [name, path] of [
      ['GENOFFICE_OFFICE_EXCEL_OUTPUT', excelPath],
      ['GENOFFICE_OFFICE_POWERPOINT_OUTPUT', powerpointPath],
      ['GENOFFICE_OFFICE_WORD_OUTPUT', wordPath],
    ]) {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
        throw new Error(`${name} must reference a non-empty regular file, not a symlink`)
      }
      if (stat.size > MAX_OFFICE_DOCUMENT_BYTES) {
        throw new Error(`${name} exceeds the 256 MiB manual-QA limit`)
      }
    }
    await mkdir(evidenceDir, { recursive: true })
    const evidenceStat = await lstat(evidenceDir)
    if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory()) {
      throw new Error('GENOFFICE_OFFICE_REOPEN_EVIDENCE must be a real directory')
    }
  })

  test('Word output renders all footnote references and the edited marker', async () => {
    expect(docxMarkerParts(wordPath)).toContain(wordMarker)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'office-word-reopen',
      openFile: wordPath,
    })
    try {
      const docs = await waitForPageWithUrl(launched.app, 'docs/out')
      await expect(docs.locator('.doc-page.ProseMirror')).toBeVisible({ timeout: 30_000 })
      await expect(docs.locator('.doc-note-ref[data-note-kind="footnote"]')).toHaveCount(20)
      await expect(docs.locator('body')).toContainText(wordMarker)
      await docs.screenshot({ path: `${evidenceDir}/codexoffice-word-reopen.png` })
    } finally {
      await closeAndSaveVideo(launched, 'office-word-reopen')
    }
  })

  test('Excel output renders its sheets, charts, and edited marker', async () => {
    expect(xlsxMarkerParts(excelPath)).toContain(excelMarker)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'office-excel-reopen',
      openFile: excelPath,
    })
    try {
      const sheets = await waitForPageWithUrl(launched.app, 'sheets/out')
      await expect(sheets.locator('body')).toContainText('Portfolio', { timeout: 30_000 })
      await expect(sheets.locator('body')).toContainText('Scenarios')
      await expect(sheets.locator('body')).toContainText('Dashboard')
      await expect(sheets.locator('canvas').first()).toBeVisible()
      await sheets.waitForFunction(() =>
        [...document.querySelectorAll('canvas')].some((canvas) => {
          const rect = canvas.getBoundingClientRect()
          return rect.width > 500 && rect.height > 300
        }),
      )

      await sheets.screenshot({ path: `${evidenceDir}/codexoffice-excel-dashboard.png` })
      await sheets.getByText('Portfolio', { exact: true }).last().click()
      const nameBox = sheets.locator('.name-box')
      await nameBox.fill('A2')
      await nameBox.press('Enter')
      await expect(nameBox).toHaveValue('A2')
      await sheets.screenshot({ path: `${evidenceDir}/codexoffice-excel-portfolio.png` })
    } finally {
      await closeAndSaveVideo(launched, 'office-excel-reopen')
    }
  })

  test('PowerPoint output renders all slides and the edited marker', async () => {
    expect(pptxEntry(powerpointPath, 'ppt/slides/slide1.xml')).toContain(powerpointMarker)
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'office-powerpoint-reopen',
      openFile: powerpointPath,
    })
    try {
      const slides = await waitForPageWithUrl(launched.app, 'slides/out')
      await expect(slides.locator('.slide-list .thumb')).toHaveCount(5, { timeout: 30_000 })
      await expect(slides.locator('.stage-rel canvas').first()).toBeVisible()
      await expect(slides.locator('.status-msg')).toContainText(
        `Opened ${powerpointPath.split('/').at(-1)} (5 slides)`,
      )
      await slides.screenshot({ path: `${evidenceDir}/codexoffice-powerpoint-reopen.png` })
    } finally {
      await closeAndSaveVideo(launched, 'office-powerpoint-reopen')
    }
  })
})
