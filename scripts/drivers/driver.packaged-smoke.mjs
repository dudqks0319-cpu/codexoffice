import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const appBundle = process.env.GENOFFICE_PACKAGED_APP
  ? resolve(process.env.GENOFFICE_PACKAGED_APP)
  : join(repoRoot, 'apps/shell/release/mac-arm64/Codexoffice.app')
const appBinary = join(appBundle, 'Contents/MacOS/Codexoffice')
const homeDir = await mkdtemp(join(tmpdir(), 'codexoffice-packaged-home-'))
const tempDir = join(homeDir, 'tmp')
await mkdir(tempDir)
const evidenceDir = join(repoRoot, 'qa-artifacts', 'trust-workflow-20260809')
await mkdir(evidenceDir, { recursive: true })
const userDataDir = join(homeDir, 'user-data')
await mkdir(userDataDir, { recursive: true })
await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
const port = 9347

const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env
const child = spawn(appBinary, [`--remote-debugging-port=${port}`], {
  env: {
    ...parentEnv,
    HOME: parentEnv.HOME,
    TMPDIR: tempDir,
    GENOFFICE_LANG: 'en',
    GENOFFICE_USER_DATA: userDataDir,
    GENOFFICE_PACKAGED_SMOKE: '1',
    GENOFFICE_CODEX_IMAGE_GENERATION: '1',
  },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOutput = ''
child.stdout.on('data', (chunk) => {
  childOutput += String(chunk)
})
child.stderr.on('data', (chunk) => {
  childOutput += String(chunk)
})

const deadline = Date.now() + 30_000
let browser
while (!browser && Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (response.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  } catch {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
}
if (!browser) {
  child.kill('SIGTERM')
  throw new Error(`Packaged app did not expose CDP within 30s\n${childOutput}`)
}

async function waitForPage(context, urlPart, timeoutMs = 30_000) {
  const stopAt = Date.now() + timeoutMs
  while (Date.now() < stopAt) {
    const candidate = context
      .pages()
      .find((item) => item.url().includes(urlPart))
    if (candidate) return candidate
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`No packaged page with URL containing ${urlPart}`)
}

function clickImageConfirmation() {
  const script = `
tell application "System Events"
  repeat 80 times
    if exists process "Codexoffice" then
      tell process "Codexoffice"
        if exists window 1 then
          if exists button "Generate image" of window 1 then
            click button "Generate image" of window 1
            return
          end if
        end if
      end tell
    end if
    delay 0.25
  end repeat
end tell
`
  return new Promise((resolvePromise) => {
    execFile('/usr/bin/osascript', ['-e', script], (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

try {
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? (await context.waitForEvent('page'))
  await page.waitForTimeout(2_000)
  if (await page.locator('.onb-overlay').isVisible().catch(() => false)) {
    await page.locator('.onb-skip').click()
  }
  const home = {
    title: await page.title(),
    url: page.url(),
    hero: await page.locator('.home-hero').isVisible().catch(() => false),
    account: await page.locator('.account-btn').getAttribute('aria-label').catch(() => null),
    quickCards: await page.locator('.quick-card').count().catch(() => -1),
  }
  await page.screenshot({ path: join(evidenceDir, '01-packaged-home.png') })

  await page.locator('.account-btn').click()
  const accountMenu = await page.locator('.account-menu').innerText().catch(() => '')
  const loginButton = page.locator('.account-menu-item').first()
  const loginAvailable = await loginButton.isVisible().catch(() => false)
  if (loginAvailable) await loginButton.click()
  await page.waitForTimeout(loginAvailable ? 12_000 : 0)
  const accountText = await page.locator('.account-btn').innerText().catch(() => '')
  const login = {
    menu: accountMenu,
    attempted: loginAvailable,
    accountText,
    loggedIn: /logged in/i.test(accountText),
    waiting: await page.locator('.account-avatar.waiting').isVisible().catch(() => false),
  }

  await page.locator('.tab-bar .tab-item.tab-home').click().catch(() => {})
  await page.locator('.quick-card').first().click()
  const docsPage = await waitForPage(context, '/modules/docs/')
  await docsPage.waitForTimeout(2_000)
  const docEditor = docsPage.locator('[contenteditable="true"]').first()
  const editorCount = await docsPage.locator('[contenteditable="true"]').count().catch(() => 0)
  if (editorCount > 0) {
    await docEditor.fill('Codexoffice packaged text smoke')
  }
  const docs = {
    url: docsPage.url(),
    editorCount,
    editedText: await docsPage.locator('body').innerText().catch(() => ''),
  }
  await docsPage.screenshot({ path: join(evidenceDir, '02-packaged-docs-text.png') })

  await page.locator('.tab-bar .tab-item.tab-home').click()
  await page.locator('.quick-card').nth(1).click()
  const sheetsPage = await waitForPage(context, '/modules/sheets/')
  await sheetsPage.waitForTimeout(4_000)
  const settingsButton = sheetsPage.locator('button[aria-label="AI Settings"]')
  const settingsButtonVisible = await settingsButton.isVisible().catch(() => false)
  let settings = { status: 'failed', detail: 'Codex model settings button was not visible' }
  if (settingsButtonVisible) {
    await settingsButton.click()
    const dialog = sheetsPage.locator('[role="dialog"][aria-labelledby="codex-settings-title"]')
    const modelInput = dialog.locator('#codex-model-input')
    const opened = await dialog.isVisible().catch(() => false)
    const before = await modelInput.inputValue().catch(() => '')
    await modelInput.fill('gpt-5.6-luna')
    await dialog.locator('.ai-reasoning-option', { hasText: 'max' }).click()
    await sheetsPage.screenshot({ path: join(evidenceDir, '03-luna-max-settings.png') })
    await dialog.getByRole('button', { name: 'Save' }).click()
    await sheetsPage.waitForTimeout(300)
    const saveError = await dialog.locator('[role="alert"]').innerText().catch(() => '')
    const closedAfterSave = !(await dialog.isVisible().catch(() => false))
    const afterSettings = await sheetsPage.evaluate(() => window.desktopApi.getAiSettings())
    await sheetsPage.reload()
    await sheetsPage.waitForSelector('.ai-panel-header', { timeout: 30_000 })
    const restoredSettings = await sheetsPage.evaluate(() => window.desktopApi.getAiSettings())
    const after = {
      model: afterSettings.providers.codex.model,
      reasoningEffort: afterSettings.providers.codex.reasoningEffort,
    }
    const restored = {
      model: restoredSettings.providers.codex.model,
      reasoningEffort: restoredSettings.providers.codex.reasoningEffort,
    }
    settings = {
      status:
        after.model === 'gpt-5.6-luna' &&
        after.reasoningEffort === 'max' &&
        restored.model === 'gpt-5.6-luna' &&
        restored.reasoningEffort === 'max'
          ? 'passed'
          : 'failed',
      opened,
      before,
      saveError,
      closedAfterSave,
      after,
      restored,
    }
  }
  await sheetsPage.screenshot({ path: join(evidenceDir, '04-packaged-sheets-model-settings.png') })

  const nameBox = sheetsPage.locator('input[aria-label="Name Box"]')
  async function setCell(address, value) {
    await nameBox.fill(address)
    await nameBox.press('Enter')
    await sheetsPage.keyboard.press('Enter')
    await sheetsPage.keyboard.insertText(value)
    await sheetsPage.keyboard.press('Enter')
  }
  await setCell('A1', 'Revenue')
  await setCell('B1', 'Cost')
  await setCell('A2', '100')
  await setCell('B2', '50')
  await setCell('C2', '#REF!')
  const qaButton = sheetsPage.getByRole('button', { name: 'AI Check' })
  const qaButtonVisible = await qaButton.isVisible().catch(() => false)
  if (qaButtonVisible) {
    await qaButton.click()
    await sheetsPage.locator('.ai-qa-card').waitFor({ state: 'visible', timeout: 30_000 })
  }
  const qa = {
    buttonVisible: qaButtonVisible,
    card: await sheetsPage.locator('.ai-qa-card').innerText().catch(() => ''),
    findingCount: await sheetsPage.locator('.ai-qa-finding').count().catch(() => 0),
  }
  await sheetsPage.screenshot({ path: join(evidenceDir, '05-sheets-qa.png') })

  await page.locator('.tab-bar .tab-item.tab-home').click()
  await page.locator('.quick-card').nth(2).click()
  const slidesPage = await waitForPage(context, '/modules/slides/')
  await slidesPage.waitForTimeout(4_000)
  const slideStatus = await slidesPage
    .evaluate(async () => ({
      body: document.body.innerText.slice(0, 1200),
      aiInput: Boolean(document.querySelector('[data-slides-ai-input="true"]')),
      slides: await window.slidesApi.getRenderSlides(),
      account: await window.slidesApi.aiCodexStatus(),
    }))
    .catch((error) => ({ error: String(error) }))

  let image = { status: 'blocked-external-auth', detail: 'Codex account was not signed in' }
  if (slideStatus.account?.loggedIn && !slideStatus.error) {
    const imageOp = {
      requestId: `packaged-smoke-${Date.now()}`,
      slideIndex: 0,
      prompt: 'A clean editorial sunrise over a calm ocean, original bitmap, warm coral and navy palette, no text',
      xPx: 80,
      yPx: 120,
      wPx: 480,
      hPx: 270,
      fitWidthPx: 1280,
    }
    const confirmation = clickImageConfirmation()
    const result = await slidesPage.evaluate((op) => window.slidesApi.generateSlideImage(op), imageOp)
    const confirmationResult = await confirmation
    const currentSlides = await slidesPage.evaluate(() => window.slidesApi.getRenderSlides())
    image = {
      status: result.ok ? 'passed' : 'failed',
      result,
      currentSlides,
      confirmation: confirmationResult,
    }
  }
  await slidesPage.screenshot({ path: join(evidenceDir, '06-packaged-slides.png') })

  const report = {
    evidenceDir,
    userDataDir,
    cdpPort: port,
    home,
    login,
    docs,
    settings,
    qa,
    slideStatus,
    image,
  }
  await writeFile(join(evidenceDir, 'packaged-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close().catch(() => {})
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // The process group may already have exited.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The process group may already have exited.
    }
  }
}
