import { test, expect } from '@playwright/test'
import { writeFile, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

async function makeFixture(
  path: string,
  text = 'Codexoffice PDF round-trip fixture',
): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(text, {
    x: 72,
    y: 700,
    size: 20,
    font,
    color: rgb(0.1, 0.2, 0.3),
  })
  await writeFile(path, await doc.save({ useObjectStreams: false }))
}

async function drawRectangle(pdf: Page): Promise<void> {
  await pdf.getByRole('button', { name: 'Rectangle', exact: true }).click()
  const layer = pdf.locator('.pdf-draw-layer').first()
  const box = await layer.boundingBox()
  if (!box) throw new Error('PDF drawing layer not found')
  await pdf.mouse.move(box.x + 80, box.y + 120)
  await pdf.mouse.down()
  await pdf.mouse.move(box.x + 240, box.y + 220, { steps: 8 })
  await pdf.mouse.up()
  await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(1)
}

async function waitForPdf(page: Page): Promise<void> {
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.tb-page-total')).toContainText('of 1')
}

test.describe('pdf: annotate and save an external document', () => {
  test('the sandbox memory kill-switch fails closed before the original is changed', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-memory-e2e-'))
    const document = join(scratch, 'memory-limit.pdf')
    await makeFixture(document)
    const original = await readFile(document)
    const previousLimit = process.env.GENOFFICE_PDF_JOB_TEST_MEMORY_LIMIT_KIB
    process.env.GENOFFICE_PDF_JOB_TEST_MEMORY_LIMIT_KIB = '1'

    let launched: Awaited<ReturnType<typeof launchShell>> | undefined
    try {
      launched = await launchShell({
        onboardingSeen: true,
        videoDir: 'pdf-memory-limit',
        openFile: document,
      })
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await waitForPdf(pdf)
      await drawRectangle(pdf)

      await pdf.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(pdf.locator('.tb-save-error')).toContainText('memory limit')
      await expect(pdf.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      expect((await readFile(document)).equals(original)).toBe(true)
      await expect(launched.page.locator('body')).toBeVisible()
    } finally {
      if (previousLimit === undefined) delete process.env.GENOFFICE_PDF_JOB_TEST_MEMORY_LIMIT_KIB
      else process.env.GENOFFICE_PDF_JOB_TEST_MEMORY_LIMIT_KIB = previousLimit
      if (launched) await closeAndSaveVideo(launched, 'pdf-memory-limit')
    }
  })

  test('rectangle annotation round-trips through save and reopen', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-e2e-'))
    const document = join(scratch, 'annotate-save.pdf')
    await makeFixture(document)
    expect((await readFile(document, 'latin1')).includes('/Subtype /Square')).toBe(false)

    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-annotate-save',
      openFile: document,
    })
    try {
      const pdf = await waitForPageWithUrl(first.app, 'pdf/out')
      await waitForPdf(pdf)

      await drawRectangle(pdf)
      const save = pdf.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeEnabled()
      await save.click()
      await expect(pdf.locator('.tb-save-ok')).toContainText('Saved')
      await expect(save).toBeDisabled()
      expect((await readFile(document, 'latin1')).includes('/Subtype /Square')).toBe(true)
      await pdf.screenshot({ path: screenshotPath('pdf-annotation-saved') })
    } finally {
      await closeAndSaveVideo(first, 'pdf-annotate-save')
    }

    const second = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-annotate-reopen',
      openFile: document,
    })
    try {
      const pdf = await waitForPageWithUrl(second.app, 'pdf/out')
      await waitForPdf(pdf)
      await expect(pdf.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      expect((await readFile(document, 'latin1')).includes('/Subtype /Square')).toBe(true)
      await pdf.screenshot({ path: screenshotPath('pdf-annotation-reopened') })
    } finally {
      await closeAndSaveVideo(second, 'pdf-annotate-reopen')
    }
  })

  test('an external replacement is preserved and the pending edit becomes a recovery PDF', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-conflict-e2e-'))
    const document = join(scratch, 'external-conflict.pdf')
    await makeFixture(document)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-external-conflict',
      openFile: document,
    })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await waitForPdf(pdf)
      await drawRectangle(pdf)

      // Simulate Preview/Acrobat replacing the file after this view loaded it.
      await makeFixture(document, 'External writer replacement must survive')
      const externalBytes = await readFile(document)

      await pdf.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(pdf.locator('.tb-save-error')).toContainText('changed in another app')
      await expect(pdf.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()

      // The other app's bytes remain authoritative on the original path.
      expect((await readFile(document)).equals(externalBytes)).toBe(true)
      expect(externalBytes.toString('latin1')).not.toContain('/Subtype /Square')

      const recoveryDir = join(launched.userDataDir, 'pdf-conflict-recovery')
      await expect
        .poll(async () => (await readdir(recoveryDir)).filter((name) => name.endsWith('.pdf')))
        .toHaveLength(1)
      const [recoveryName] = (await readdir(recoveryDir)).filter((name) => name.endsWith('.pdf'))
      const recovery = await readFile(join(recoveryDir, recoveryName!))
      expect(recovery.toString('latin1')).toContain('/Subtype /Square')
    } finally {
      await closeAndSaveVideo(launched, 'pdf-external-conflict')
    }
  })

  test('a dirty edit writes an isolated crash-recovery copy and a real save clears it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-crash-recovery-e2e-'))
    const document = join(scratch, 'crash-recovery.pdf')
    await makeFixture(document)

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-crash-recovery',
      openFile: document,
    })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await waitForPdf(pdf)
      await drawRectangle(pdf)

      // Blur is the immediate recovery trigger; unlike normal autosave it never
      // overwrites the source and does not require a prior explicit Save.
      await pdf.evaluate(() => window.dispatchEvent(new Event('blur')))
      const recoveryDir = join(launched.userDataDir, 'pdf-autosave')
      await expect
        .poll(async () => {
          try {
            return (await readdir(recoveryDir)).sort()
          } catch {
            return []
          }
        })
        .toEqual(
          expect.arrayContaining([
            expect.stringMatching(/\.json$/),
            expect.stringMatching(/\.pdf$/),
          ]),
        )

      expect((await readFile(document, 'latin1')).includes('/Subtype /Square')).toBe(false)
      const recoveryName = (await readdir(recoveryDir)).find((name) => name.endsWith('.pdf'))
      expect(recoveryName).toBeTruthy()
      expect(
        (await readFile(join(recoveryDir, recoveryName!), 'latin1')).includes('/Subtype /Square'),
      ).toBe(true)

      await pdf.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(pdf.locator('.tb-save-ok')).toContainText('Saved')
      await expect.poll(async () => await readdir(recoveryDir)).toEqual([])
      expect((await readFile(document, 'latin1')).includes('/Subtype /Square')).toBe(true)
    } finally {
      await closeAndSaveVideo(launched, 'pdf-crash-recovery')
    }
  })
})
