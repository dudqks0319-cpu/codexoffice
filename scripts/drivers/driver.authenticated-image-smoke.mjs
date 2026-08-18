import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { assertPackagedSmokeIsolation } from './packaged-smoke-isolation.mjs'

assertPackagedSmokeIsolation()

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const appBundle = resolve(
  process.env.GENOFFICE_PACKAGED_APP ??
    join(repoRoot, 'apps/shell/release-final/Codexoffice.app'),
)
const authSource = process.env.GENOFFICE_CODEX_AUTH_SOURCE
if (!authSource) throw new Error('GENOFFICE_CODEX_AUTH_SOURCE is required')

const homeDir = await mkdtemp(join(tmpdir(), 'codexoffice-auth-image-'))
await chmod(homeDir, 0o700)
const userDataDir = join(homeDir, 'user-data')
const codexHome = join(userDataDir, 'codex')
await mkdir(codexHome, { recursive: true, mode: 0o700 })
await copyFile(join(resolve(authSource), 'auth.json'), join(codexHome, 'auth.json'))
await chmod(join(codexHome, 'auth.json'), 0o600)
await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))

const evidenceDir = join(repoRoot, 'qa-artifacts', 'trust-workflow-20260809')
await mkdir(evidenceDir, { recursive: true })
const port = 9361
const appBinary = join(appBundle, 'Contents', 'MacOS', 'Codexoffice')
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env
const child = spawn(appBinary, [`--remote-debugging-port=${port}`], {
  env: {
    ...parentEnv,
    GENOFFICE_LANG: 'en',
    GENOFFICE_USER_DATA: userDataDir,
    GENOFFICE_PACKAGED_SMOKE: '1',
    GENOFFICE_SMOKE_AUTO_CONFIRM_IMAGE: '1',
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

let browser
try {
  const deadline = Date.now() + 30_000
  while (!browser && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  if (!browser) throw new Error(`Packaged app did not expose CDP within 30s\n${childOutput}`)

  const context = browser.contexts()[0]
  const homeDeadline = Date.now() + 30_000
  let homePage
  while (!homePage && Date.now() < homeDeadline) {
    for (const candidate of context.pages()) {
      if ((await candidate.locator('.quick-card').count().catch(() => 0)) > 0) {
        homePage = candidate
        break
      }
    }
    if (!homePage) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  if (!homePage) {
    const pages = context.pages().map((page) => ({ title: page.title(), url: page.url() }))
    throw new Error(`Packaged home page did not become ready: ${JSON.stringify(await Promise.all(pages))}`)
  }
  await homePage.waitForTimeout(2_000)
  if (await homePage.locator('.onb-overlay').isVisible().catch(() => false)) {
    await homePage.locator('.onb-skip').click()
  }
  await homePage.evaluate(() => window.aiOffice.newSlide())

  const stopAt = Date.now() + 30_000
  let slidesPage
  while (!slidesPage && Date.now() < stopAt) {
    slidesPage = context.pages().find((page) => page.url().includes('/modules/slides/'))
    if (!slidesPage) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  if (!slidesPage) throw new Error('Slides page did not open')
  await slidesPage.waitForSelector('[data-slides-ai-input="true"]', { timeout: 30_000 })

  const account = await slidesPage.evaluate(() => window.slidesApi.aiCodexStatus())
  await slidesPage.screenshot({ path: join(evidenceDir, '07-authenticated-before-image.png') })
  if (!account.loggedIn) throw new Error('Seeded Codex session is not logged in')

  const result = await slidesPage.evaluate((requestId) => {
    return window.slidesApi.generateSlideImage({
      requestId,
      slideIndex: 0,
      prompt:
        'A clean editorial sunrise over a calm ocean, original bitmap, warm coral and navy palette, no text',
      xPx: 80,
      yPx: 120,
      wPx: 480,
      hPx: 270,
      fitWidthPx: 1280,
    })
  }, `authenticated-image-${Date.now()}`)
  const confirmationResult = { ok: true, mode: 'isolated-packaged-smoke' }
  if (result.ok) {
    await slidesPage.reload({ waitUntil: 'domcontentloaded' })
    await slidesPage.waitForSelector('[data-slides-ai-input="true"]', { timeout: 30_000 })
    await slidesPage.waitForTimeout(2_000)
  }
  const slides = await slidesPage.evaluate(() => window.slidesApi.getRenderSlides())
  const nodes = slides[0]?.nodes ?? []
  const nodeKinds = nodes.reduce((counts, node) => {
    const key = node.type ?? node.kind ?? 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
  await slidesPage.screenshot({ path: join(evidenceDir, '08-authenticated-image-inserted.png') })

  const report = {
    packagedApp: appBundle,
    login: { loggedIn: account.loggedIn },
    image: result.ok
      ? {
          status: 'passed',
          sourceId: result.sourceId,
          mime: result.image.mime,
          width: result.image.width,
          height: result.image.height,
        }
      : { status: 'failed', code: result.code, error: result.error },
    confirmation: confirmationResult,
    slideCount: slides.length,
    nodeKinds,
  }
  await writeFile(
    join(evidenceDir, 'authenticated-image-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  if (!result.ok) process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
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
  await rm(homeDir, { recursive: true, force: true })
}
