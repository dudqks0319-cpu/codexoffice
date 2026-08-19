import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

const JOB_ROOT_PREFIX = 'genoffice-pdf-job-'

async function makeFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Codexoffice PDF isolated-transform stress fixture', {
    x: 72,
    y: 700,
    size: 20,
    font,
    color: rgb(0.1, 0.2, 0.3),
  })
  await writeFile(path, await doc.save({ useObjectStreams: false }))
}

async function waitForPdf(page: Page): Promise<void> {
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.tb-page-total')).toContainText('of 1')
}

async function drawRectangle(pdf: Page, iteration: number): Promise<void> {
  const rectangle = pdf.getByRole('button', { name: 'Rectangle', exact: true })
  if (!(await rectangle.evaluate((button) => button.classList.contains('active')))) {
    await rectangle.click()
  }
  const layer = pdf.locator('.pdf-draw-layer').first()
  const box = await layer.boundingBox()
  if (!box) throw new Error('PDF drawing layer not found')
  const offset = (iteration % 5) * 8
  await pdf.mouse.move(box.x + 70 + offset, box.y + 110 + offset)
  await pdf.mouse.down()
  await pdf.mouse.move(box.x + 180 + offset, box.y + 170 + offset, { steps: 4 })
  await pdf.mouse.up()
  await expect(pdf.locator('.pdf-draw-shape')).toHaveCount(1)
}

interface RuntimeSnapshot {
  readonly totalWorkingSetKiB: number
  readonly tabGenerations: string[]
  readonly windowCount: number
}

async function runtimeSnapshot(app: ElectronApplication): Promise<RuntimeSnapshot> {
  return await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const metrics = electronApp.getAppMetrics()
    return {
      totalWorkingSetKiB: metrics.reduce(
        (total, metric) => total + metric.memory.workingSetSize,
        0,
      ),
      tabGenerations: metrics
        .filter((metric) => metric.type === 'Tab')
        .map((metric) => `${metric.pid}:${metric.creationTime}`)
        .sort(),
      windowCount: BrowserWindow.getAllWindows().length,
    }
  })
}

async function jobRoots(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(JOB_ROOT_PREFIX)).sort()
}

async function expectRuntimeReturnedToBaseline(
  app: ElectronApplication,
  baseline: RuntimeSnapshot,
  baselineRoots: string[],
): Promise<RuntimeSnapshot> {
  await expect
    .poll(async () => (await runtimeSnapshot(app)).windowCount, { timeout: 15_000 })
    .toBe(baseline.windowCount)
  await expect
    .poll(async () => {
      const current = await runtimeSnapshot(app)
      return current.tabGenerations.filter((entry) => !baseline.tabGenerations.includes(entry))
    })
    .toEqual([])
  await expect.poll(jobRoots).toEqual(baselineRoots)
  return await runtimeSnapshot(app)
}

test.describe('pdf: isolated transformation lifecycle', () => {
  test('20 sequential saves release renderer processes, staged files, and RSS', async () => {
    test.setTimeout(180_000)
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-stress-e2e-'))
    const document = join(scratch, 'twenty-saves.pdf')
    await makeFixture(document)
    const baselineRoots = await jobRoots()
    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'pdf-memory-stress',
      openFile: document,
    })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await waitForPdf(pdf)
      const baseline = await runtimeSnapshot(launched.app)
      const postSaveWorkingSets: number[] = []
      let observedHiddenWindow = false

      for (let iteration = 0; iteration < 20; iteration += 1) {
        await drawRectangle(pdf, iteration)
        const save = pdf.getByRole('button', { name: 'Save', exact: true })
        await expect(save).toBeEnabled()

        let sampling = true
        const sampler = (async () => {
          while (sampling) {
            const snapshot = await runtimeSnapshot(launched.app)
            if (snapshot.windowCount > baseline.windowCount) observedHiddenWindow = true
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        })()
        try {
          await save.click()
          // The green "Saved" toast intentionally disappears after two seconds.
          // Under a full-suite CPU load the metrics sampler can outlive that
          // transient element, so wait on the stable post-save state instead:
          // no dirty/saving indicator, no error, and Save disabled.
          await expect
            .poll(
              async () => ({
                disabled: await save.isDisabled(),
                error: await pdf.locator('.tb-save-error').count(),
                pending: await pdf.locator('.tb-save-pending').count(),
              }),
              { timeout: 30_000 },
            )
            .toEqual({ disabled: true, error: 0, pending: 0 })
        } finally {
          sampling = false
          await sampler
        }

        const settled = await expectRuntimeReturnedToBaseline(launched.app, baseline, baselineRoots)
        postSaveWorkingSets.push(settled.totalWorkingSetKiB)
      }

      expect(observedHiddenWindow).toBe(true)
      const finalWorkingSet = postSaveWorkingSets.at(-1)!
      // Allow normal Chromium caching while rejecting an unbounded per-job slope.
      expect(finalWorkingSet).toBeLessThanOrEqual(baseline.totalWorkingSetKiB + 256 * 1024)
      expect(finalWorkingSet).toBeLessThanOrEqual(postSaveWorkingSets[4]! + 128 * 1024)
      expect((await readFile(document, 'latin1')).match(/\/Subtype \/Square/g)?.length).toBe(20)
    } finally {
      await closeAndSaveVideo(launched, 'pdf-memory-stress')
      await rm(scratch, { recursive: true, force: true })
    }
  })

  test('an actual renderer timeout preserves the source and cleans the job lifecycle', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-timeout-e2e-'))
    const document = join(scratch, 'timeout.pdf')
    await makeFixture(document)
    const original = await readFile(document)
    const baselineRoots = await jobRoots()
    const previousTimeout = process.env.GENOFFICE_PDF_JOB_TEST_TIMEOUT_MS
    process.env.GENOFFICE_PDF_JOB_TEST_TIMEOUT_MS = '1'
    let launched: Awaited<ReturnType<typeof launchShell>> | undefined

    try {
      launched = await launchShell({
        onboardingSeen: true,
        videoDir: 'pdf-timeout',
        openFile: document,
      })
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await waitForPdf(pdf)
      const baseline = await runtimeSnapshot(launched.app)
      await drawRectangle(pdf, 0)

      await pdf.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(pdf.locator('.tb-save-error')).toContainText('timed out')
      await expect(pdf.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      expect((await readFile(document)).equals(original)).toBe(true)
      await expectRuntimeReturnedToBaseline(launched.app, baseline, baselineRoots)
      await expect(launched.page.locator('body')).toBeVisible()
    } finally {
      if (previousTimeout === undefined) delete process.env.GENOFFICE_PDF_JOB_TEST_TIMEOUT_MS
      else process.env.GENOFFICE_PDF_JOB_TEST_TIMEOUT_MS = previousTimeout
      if (launched) await closeAndSaveVideo(launched, 'pdf-timeout')
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
