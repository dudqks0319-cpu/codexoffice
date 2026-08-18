import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

const FIXTURE = resolve(
  __dirname,
  '../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
)

function pptxEntry(presentationPath: string, entry: string): string {
  return execFileSync('unzip', ['-p', presentationPath, entry]).toString()
}

async function waitForPresentation(page: Page): Promise<void> {
  await expect(page.locator('.slide-list .thumb')).toHaveCount(5, { timeout: 30_000 })
  await expect(page.locator('.stage-rel canvas').first()).toBeVisible()
}

test.describe('slides: apply a design and save an external presentation', () => {
  test('theme round-trips through save and reopen', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-slides-e2e-'))
    const presentation = join(scratch, 'design-save.pptx')
    await copyFile(FIXTURE, presentation)

    const originalTheme = pptxEntry(presentation, 'ppt/theme/theme1.xml')
    expect(originalTheme).not.toContain('name="Graphite"')
    expect(originalTheme).not.toContain('val="4FC3F7"')

    // Session 1: apply a built-in design to a disposable fixture copy and save it.
    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'slides-design-save',
      openFile: presentation,
    })
    try {
      const slides = await waitForPageWithUrl(first.app, 'slides/out')
      await waitForPresentation(slides)

      await slides.getByRole('button', { name: 'Design', exact: true }).click()
      await slides.locator('.theme-card').filter({ hasText: 'Graphite' }).click()
      await expect(slides.locator('.status-msg')).toContainText('Applied theme "Graphite"')

      const save = slides.locator('.qa-btn[title="Save (⌘S)"]')
      await expect(save).toBeEnabled()
      await save.click()
      await expect(slides.locator('.status-msg')).toContainText('Saved design-save.pptx')
      await expect(save).toBeDisabled()

      const savedTheme = pptxEntry(presentation, 'ppt/theme/theme1.xml')
      expect(savedTheme).toContain('name="Graphite"')
      expect(savedTheme).toContain('val="4FC3F7"')
      expect(savedTheme).toContain('typeface="Segoe UI"')
      expect(pptxEntry(presentation, 'ppt/slides/slide1.xml')).toContain('Q3 Business Review')
      await slides.screenshot({ path: screenshotPath('slides-design-saved') })
    } finally {
      await closeAndSaveVideo(first, 'slides-design-save')
    }

    // Session 2: a fresh app process must parse and render the persisted deck.
    const second = await launchShell({
      onboardingSeen: true,
      videoDir: 'slides-design-reopen',
      openFile: presentation,
    })
    try {
      const slides = await waitForPageWithUrl(second.app, 'slides/out')
      await waitForPresentation(slides)
      await expect(slides.locator('.status-msg')).toContainText(
        'Opened design-save.pptx (5 slides)',
      )
      await expect(slides.locator('.qa-btn[title="Save (⌘S)"]')).toBeDisabled()
      expect(pptxEntry(presentation, 'ppt/theme/theme1.xml')).toContain('name="Graphite"')
      await slides.screenshot({ path: screenshotPath('slides-design-reopened') })
    } finally {
      await closeAndSaveVideo(second, 'slides-design-reopen')
    }
  })
})
