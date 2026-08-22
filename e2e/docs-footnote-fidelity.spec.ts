import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl } from './helpers'

const FIXTURE = resolve(
  __dirname,
  '../apps/docs/tests/pagination-corpus/docx/06-with-footnotes.docx',
)
const MARKER = 'E2E footnote fidelity marker'

function docxEntry(documentPath: string, entry: string): string {
  return execFileSync('unzip', ['-p', documentPath, entry]).toString()
}

function footnoteEntry(xml: string, id: string): string {
  const match = new RegExp(`<w:footnote\\s[^>]*w:id="${id}"[^>]*>[\\s\\S]*?</w:footnote>`).exec(xml)
  if (!match) throw new Error(`footnote ${id} not found`)
  return match[0]
}

function structuralFootnotes(xml: string): string[] {
  return [...xml.matchAll(/<w:footnote\s[^>]*w:type="[^"]+"[^>]*>[\s\S]*?<\/w:footnote>/g)].map(
    (match) => match[0],
  )
}

function bodyFootnoteIds(xml: string): string[] {
  return [...xml.matchAll(/<w:footnoteReference\s[^>]*w:id="([^"]+)"[^>]*\/>/g)].map(
    (match) => match[1]!,
  )
}

async function waitForFootnoteDocument(page: Page): Promise<void> {
  await expect(page.locator('.doc-page.ProseMirror')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.doc-note-ref[data-note-kind="footnote"]')).toHaveCount(20)
  await expect(page.locator('.page-gap-note').first()).toBeVisible()
}

test.describe('docs: footnote OOXML fidelity', () => {
  test('editing one footnote preserves sibling notes, separators, and body references', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-docs-footnote-e2e-'))
    const document = join(scratch, 'footnote-fidelity.docx')
    await copyFile(FIXTURE, document)

    const originalNotes = docxEntry(document, 'word/footnotes.xml')
    const originalBody = docxEntry(document, 'word/document.xml')
    const untouchedSibling = footnoteEntry(originalNotes, '2')
    const originalStructural = structuralFootnotes(originalNotes)
    const originalReferenceIds = bodyFootnoteIds(originalBody)
    expect(originalStructural).toHaveLength(2)
    expect(originalReferenceIds).toHaveLength(20)

    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'docs-footnote-fidelity-save',
      openFile: document,
    })
    try {
      const docs = await waitForPageWithUrl(first.app, 'docs/out')
      await waitForFootnoteDocument(docs)

      await docs.locator('.page-gap-note').first().dblclick()
      await expect(docs.getByRole('heading', { name: 'Edit footnote' })).toBeVisible()
      await docs.locator('.prompt-textarea').fill(MARKER)
      await docs.getByRole('button', { name: 'OK', exact: true }).click()

      const save = docs.locator('.qa-btn[title="Save (⌘S)"]')
      await expect(save).toBeEnabled()
      await save.click()
      await expect(docs.locator('.status-msg')).toContainText('Saved')
      await expect(save).toBeDisabled()

      const savedNotes = docxEntry(document, 'word/footnotes.xml')
      expect(footnoteEntry(savedNotes, '1')).toContain(MARKER)
      expect(footnoteEntry(savedNotes, '2')).toBe(untouchedSibling)
      expect(structuralFootnotes(savedNotes)).toEqual(originalStructural)
      expect(bodyFootnoteIds(docxEntry(document, 'word/document.xml'))).toEqual(
        originalReferenceIds,
      )
    } finally {
      await closeAndSaveVideo(first, 'docs-footnote-fidelity-save')
    }

    const second = await launchShell({
      onboardingSeen: true,
      videoDir: 'docs-footnote-fidelity-reopen',
      openFile: document,
    })
    try {
      const docs = await waitForPageWithUrl(second.app, 'docs/out')
      await waitForFootnoteDocument(docs)
      await expect(
        docs.locator('.page-gap-note, .page-note-text').filter({ hasText: MARKER }),
      ).toHaveCount(1)

      const reopenedNotes = docxEntry(document, 'word/footnotes.xml')
      expect(footnoteEntry(reopenedNotes, '1')).toContain(MARKER)
      expect(footnoteEntry(reopenedNotes, '2')).toBe(untouchedSibling)
      expect(structuralFootnotes(reopenedNotes)).toEqual(originalStructural)
      expect(bodyFootnoteIds(docxEntry(document, 'word/document.xml'))).toEqual(
        originalReferenceIds,
      )
      await expect(docs.locator('.qa-btn[title="Save (⌘S)"]')).toBeDisabled()
    } finally {
      await closeAndSaveVideo(second, 'docs-footnote-fidelity-reopen')
    }
  })
})
