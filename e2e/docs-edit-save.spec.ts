import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

const FIXTURE = resolve(__dirname, '../apps/docs/tests/pagination-corpus/docx/fixture-simple.docx')
const MARKER = ' E2E-DOCS-ROUNDTRIP'

function documentXml(documentPath: string): string {
  return execFileSync('unzip', ['-p', documentPath, 'word/document.xml']).toString()
}

async function waitForDocument(page: Page): Promise<void> {
  await expect(page.locator('.doc-page.ProseMirror')).toBeVisible({ timeout: 30_000 })
  // The fixture has one heading plus two editable paragraphs.
  await expect(page.locator('.doc-page.ProseMirror p')).toHaveCount(2)
}

test.describe('docs: edit and save an external document', () => {
  test('text edit round-trips through save and reopen', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-docs-e2e-'))
    const document = join(scratch, 'edit-save.docx')
    await copyFile(FIXTURE, document)
    expect(documentXml(document)).not.toContain(MARKER.trim())

    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'docs-edit-save',
      openFile: document,
    })
    try {
      const docs = await waitForPageWithUrl(first.app, 'docs/out')
      await waitForDocument(docs)

      const lastParagraph = docs.locator('.doc-page.ProseMirror p').last()
      await lastParagraph.click()
      await docs.keyboard.press('End')
      await docs.keyboard.type(MARKER)
      await expect(docs.locator('.doc-page.ProseMirror')).toContainText(MARKER.trim())

      const save = docs.locator('.qa-btn[title="Save (⌘S)"]')
      await expect(save).toBeEnabled()
      await save.click()
      await expect(docs.locator('.status-msg')).toContainText('Saved')
      await expect(save).toBeDisabled()
      expect(documentXml(document)).toContain(MARKER.trim())
      await docs.screenshot({ path: screenshotPath('docs-edit-saved') })
    } finally {
      await closeAndSaveVideo(first, 'docs-edit-save')
    }

    const second = await launchShell({
      onboardingSeen: true,
      videoDir: 'docs-edit-reopen',
      openFile: document,
    })
    try {
      const docs = await waitForPageWithUrl(second.app, 'docs/out')
      await waitForDocument(docs)
      await expect(docs.locator('.doc-page.ProseMirror')).toContainText(MARKER.trim())
      await expect(docs.locator('.qa-btn[title="Save (⌘S)"]')).toBeDisabled()
      await docs.screenshot({ path: screenshotPath('docs-edit-reopened') })
    } finally {
      await closeAndSaveVideo(second, 'docs-edit-reopen')
    }
  })
})
