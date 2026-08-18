import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildStreamedFormulaFixture } from '../apps/sheets/tests/fixture-builder'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

async function waitForStreamedFormulaMode(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
    timeout: 30_000,
  })
  await expect(page.locator('.status-msg')).toContainText(
    '1 formulas recalculate live (closure mode)',
    { timeout: 30_000 },
  )
}

async function selectCell(page: Page, address: string): Promise<void> {
  const nameBox = page.locator('.name-box')
  await nameBox.click()
  await nameBox.fill(address)
  await nameBox.press('Enter')
  await expect(nameBox).not.toHaveClass(/invalid/)
  await expect(nameBox).toHaveValue(address)
}

async function copyActiveCell(app: ElectronApplication, page: Page): Promise<string> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c')
  await page.waitForTimeout(100)
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

function sheetXml(workbookPath: string): string {
  return execFileSync('unzip', ['-p', workbookPath, 'xl/worksheets/sheet1.xml']).toString()
}

function customMarker(workbookPath: string): string {
  return execFileSync('unzip', ['-p', workbookPath, 'customXml/item1.xml']).toString()
}

test.describe('sheets: streamed formula edit and save', () => {
  test('a large sparse workbook recalculates, saves, and reopens without losing formulas', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'genoffice-sheets-streamed-formula-'))
    const workbook = join(scratch, 'streamed-formula.xlsx')
    await writeFile(workbook, await buildStreamedFormulaFixture())

    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'sheets-streamed-formula-edit',
      openFile: workbook,
    })
    try {
      const sheets = await waitForPageWithUrl(first.app, 'sheets/out')
      await waitForStreamedFormulaMode(sheets)

      await selectCell(sheets, 'A3')
      await expect.poll(() => copyActiveCell(first.app, sheets)).toBe('30')

      await selectCell(sheets, 'A1')
      await sheets.keyboard.type('100')
      await sheets.keyboard.press('Enter')

      await selectCell(sheets, 'A3')
      await expect.poll(() => copyActiveCell(first.app, sheets), { timeout: 10_000 }).toBe('120')

      await first.app.evaluate(({ webContents }) => {
        const view = webContents
          .getAllWebContents()
          .find((item) => item.getURL().includes('sheets/out'))
        view?.send('menu:action', 'save')
      })
      await expect(() => expect(sheetXml(workbook)).toContain('<c r="A1"><v>100</v></c>')).toPass({
        timeout: 15_000,
      })
      expect(sheetXml(workbook)).toContain('<f>SUM(A1:A2)</f><v>30</v>')
      expect(customMarker(workbook)).toContain('must-survive')
    } finally {
      await closeAndSaveVideo(first, 'sheets-streamed-formula-edit')
    }

    const second = await launchShell({
      onboardingSeen: true,
      videoDir: 'sheets-streamed-formula-reopen',
      openFile: workbook,
    })
    try {
      const sheets = await waitForPageWithUrl(second.app, 'sheets/out')
      await waitForStreamedFormulaMode(sheets)
      await selectCell(sheets, 'A3')
      await expect.poll(() => copyActiveCell(second.app, sheets), { timeout: 10_000 }).toBe('120')
    } finally {
      await closeAndSaveVideo(second, 'sheets-streamed-formula-reopen')
    }
  })
})
