import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const appBundle = resolve(process.env.GENOFFICE_PACKAGED_APP ?? '')
const authSource = process.env.GENOFFICE_CODEX_AUTH_SOURCE
if (!appBundle) throw new Error('GENOFFICE_PACKAGED_APP is required')
if (!authSource) throw new Error('GENOFFICE_CODEX_AUTH_SOURCE is required')

const evidenceDir = join(repoRoot, 'qa-artifacts', 'trust-workflow-20260809')
const outputDeck = join(evidenceDir, 'luna-max-evidence-deck.pptx')
await mkdir(evidenceDir, { recursive: true })

const root = await mkdtemp(join(tmpdir(), 'codexoffice-luna-max-'))
await chmod(root, 0o700)
const userDataDir = join(root, 'user-data')
const codexHome = join(userDataDir, 'codex')
await mkdir(codexHome, { recursive: true, mode: 0o700 })
await copyFile(join(resolve(authSource), 'auth.json'), join(codexHome, 'auth.json'))
await chmod(join(codexHome, 'auth.json'), 0o600)
await writeFile(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))
await writeFile(
  join(userDataDir, 'ai-settings.json'),
  JSON.stringify({
    provider: 'codex',
    providers: { codex: { apiKey: '', model: 'gpt-5.6-luna', reasoningEffort: 'max' } },
  }),
  { mode: 0o600 },
)

const port = 9363
const appBinary = join(appBundle, 'Contents', 'MacOS', 'Codexoffice')
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env
const child = spawn(appBinary, [`--remote-debugging-port=${port}`], {
  env: {
    ...parentEnv,
    GENOFFICE_LANG: 'en',
    GENOFFICE_USER_DATA: userDataDir,
    GENOFFICE_PACKAGED_SMOKE: '1',
  },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childOutput = ''
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    childOutput = `${childOutput}${String(chunk)}`.slice(-32_000)
  })
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
let browser
try {
  const connectDeadline = Date.now() + 30_000
  while (!browser && Date.now() < connectDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await sleep(250)
    }
  }
  if (!browser) throw new Error(`Packaged app did not expose CDP\n${childOutput}`)

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
    if (!homePage) await sleep(250)
  }
  if (!homePage) throw new Error('Packaged home page did not become ready')
  await homePage.evaluate(() => window.aiOffice.newSlide())

  const slideDeadline = Date.now() + 30_000
  let slidesPage
  while (!slidesPage && Date.now() < slideDeadline) {
    slidesPage = context.pages().find((page) => page.url().includes('/modules/slides/'))
    if (!slidesPage) await sleep(250)
  }
  if (!slidesPage) throw new Error('Slides page did not open')
  await slidesPage.waitForSelector('[data-slides-ai-input="true"]', { timeout: 30_000 })
  await slidesPage.evaluate(() => localStorage.setItem('ai-slides-qc', '0'))

  const account = await slidesPage.evaluate(() => window.slidesApi.aiCodexStatus())
  const settings = await slidesPage.evaluate(() => window.slidesApi.getAiSettings())
  if (!account.loggedIn) throw new Error('Seeded Codex session is not logged in')
  if (
    settings.providers.codex.model !== 'gpt-5.6-luna' ||
    settings.providers.codex.reasoningEffort !== 'max'
  ) {
    throw new Error(`Unexpected settings: ${JSON.stringify(settings.providers.codex)}`)
  }

  const input = slidesPage.locator('[data-slides-ai-input="true"]')
  const runReviewedJob = async ({ label, prompt, runningShot, reviewShot }) => {
    await input.fill(prompt)
    await input.press('Enter')
    await slidesPage.waitForFunction(
      () => document.querySelector('.ai-job-state')?.textContent?.trim() === 'RUNNING',
      undefined,
      { timeout: 30_000 },
    )
    if (runningShot) await slidesPage.screenshot({ path: join(evidenceDir, runningShot) })
    const completionDeadline = Date.now() + 17 * 60_000
    let lastState = ''
    let lastLogAt = 0
    while (Date.now() < completionDeadline) {
      const clarifySkip = slidesPage.locator('.ai-clarify-skip')
      if (await clarifySkip.isVisible().catch(() => false)) await clarifySkip.click()
      const state =
        (await slidesPage.locator('.ai-job-state').textContent().catch(() => null))?.trim() ?? ''
      if (state !== lastState || Date.now() - lastLogAt > 30_000) {
        console.log(`[luna-max:${label}] state=${state || 'UNKNOWN'}`)
        lastState = state
        lastLogAt = Date.now()
      }
      if (state === 'REVIEW_READY') break
      if (['FAILED', 'RECOVERY_REQUIRED', 'CANCELLED', 'RESTORED'].includes(state)) {
        await slidesPage.screenshot({
          path: join(evidenceDir, `failed-luna-max-${label}.png`),
        })
        const assistant = await slidesPage
          .locator('.ai-msg-assistant')
          .last()
          .innerText()
          .catch(() => '')
        throw new Error(`${label} ended in ${state}: ${assistant.slice(-2_000)}`)
      }
      await sleep(2_000)
    }
    const reviewState =
      (await slidesPage.locator('.ai-job-state').textContent().catch(() => null))?.trim() ?? ''
    if (reviewState !== 'REVIEW_READY') throw new Error(`${label} timed out in ${reviewState}`)
    await slidesPage.screenshot({ path: join(evidenceDir, reviewShot) })
    await slidesPage.getByRole('button', { name: 'Apply changes' }).click()
    await slidesPage.waitForFunction(
      () => document.querySelector('.ai-job-state')?.textContent?.trim() === 'COMMITTED',
      undefined,
      { timeout: 30_000 },
    )
  }

  await runReviewedJob({
    label: 'structure',
    runningShot: '09-luna-max-running.png',
    reviewShot: '10a-luna-max-structure-review.png',
    prompt: [
      'Create a concise executive decision deck about adopting Codex SDK 0.146 in a trust-first, offline-capable office suite.',
      'Do not ask clarification. Do not search the web and do not use images.',
      'Use exactly three slides in this exact order and with these exact English titles: Summary; Analysis; Risks / Next Actions.',
      'Build every page only with editable native text boxes, shapes, tables, charts, or SmartArt.',
      'Use a small number of native objects and concise qualitative assessment text. Do not invent measured facts or precise figures.',
    ].join(' '),
  })

  const structuredSlides = await slidesPage.evaluate(() => window.slidesApi.getRenderSlides())
  if (structuredSlides.length !== 3) {
    throw new Error(`Structure phase produced ${structuredSlides.length} slides instead of 3`)
  }

  await runReviewedJob({
    label: 'evidence-page-1',
    reviewShot: '10-luna-max-review-ready.png',
    prompt: [
      'Keep all slide content and layout unchanged.',
      'For page 1 only, run at most two broad web_search calls for official OpenAI Codex documentation or the official openai/codex GitHub repository.',
      'Call get_evidence_sources, read page 1, then call set_slide_evidence for page 1 with concise claim-to-source bindings and every native editable object ID on that page.',
      'Use only exact official source locators returned by get_evidence_sources. Do not edit page text, add pages, search for images, or touch pages 2 and 3.',
    ].join(' '),
  })

  await runReviewedJob({
    label: 'evidence-page-2',
    reviewShot: '10b-luna-max-page-2-review.png',
    prompt: [
      'Keep all slide content and layout unchanged. Do not run another web search.',
      'Use the trusted official sources already registered in this conversation.',
      'Call get_evidence_sources, read page 2, then call set_slide_evidence for page 2 with concise claim-to-source bindings and every native editable object ID on that page.',
      'Do not edit page text, add pages, use images, or touch pages 1 and 3.',
    ].join(' '),
  })

  await runReviewedJob({
    label: 'evidence-page-3',
    reviewShot: '10c-luna-max-page-3-review.png',
    prompt: [
      'Keep all slide content and layout unchanged. Do not run another web search.',
      'Use the trusted official sources already registered in this conversation.',
      'Call get_evidence_sources, read page 3, then call set_slide_evidence for page 3 with concise claim-to-source bindings and every native editable object ID on that page.',
      'Finally call verify_evidence_deck and fix only deterministic evidence-record errors until it passes.',
      'Do not edit page text, add pages, use images, or touch pages 1 and 2.',
    ].join(' '),
  })

  const deck = await slidesPage.evaluate(async () => {
    const slides = await window.slidesApi.getRenderSlides()
    const notes = await Promise.all(slides.map((_slide, index) => window.slidesApi.getNotes(index)))
    const textOf = (layout) =>
      layout?.lines?.flatMap((line) => line.runs.map((run) => run.text)).join(' ') ?? ''
    const nodeText = (node) => {
      if (node.type === 'group') return node.children.map(nodeText).join(' ')
      if (node.type === 'table') return node.cells.map((cell) => textOf(cell.text)).join(' ')
      if (node.type === 'chart') return node.labels.map((label) => label.text).join(' ')
      return textOf(node.text)
    }
    return {
      slides: slides.map((slide) => ({
        text: slide.nodes.map(nodeText).join(' ').replace(/\s+/g, ' ').trim(),
        nodeTypes: slide.nodes.map((node) => node.type),
        editableNodes: slide.nodes.filter(
          (node) => !node.decoration && ['shape', 'text', 'table', 'chart', 'group'].includes(node.type),
        ).length,
      })),
      notes,
    }
  })

  const expectedTitles = ['Summary', 'Analysis', 'Risks / Next Actions']
  if (deck.slides.length !== 3) throw new Error(`Expected 3 slides, found ${deck.slides.length}`)
  for (let index = 0; index < 3; index++) {
    if (!deck.slides[index].text.includes(expectedTitles[index])) {
      throw new Error(`Slide ${index + 1} is missing title ${expectedTitles[index]}`)
    }
    if (deck.slides[index].editableNodes < 1) {
      throw new Error(`Slide ${index + 1} lacks editable native nodes`)
    }
    if (!deck.notes[index]?.includes('[GenOffice Evidence]')) {
      throw new Error(`Slide ${index + 1} lacks evidence notes`)
    }
  }

  const thumbs = slidesPage.locator('.slide-list .thumb')
  for (let index = 0; index < 3; index++) {
    await thumbs.nth(index).click()
    await slidesPage.waitForTimeout(500)
    await slidesPage.screenshot({
      path: join(evidenceDir, `11-luna-max-slide-${index + 1}.png`),
    })
  }

  const saveButton = slidesPage.locator('button.qa-btn').first()
  await saveButton.click()
  await slidesPage.waitForFunction(
    () => document.querySelector('.status-msg')?.textContent?.includes('Saved'),
    undefined,
    { timeout: 120_000 },
  )
  const recent = await slidesPage.evaluate(() => window.slidesApi.getRecentFiles())
  const savedPath = recent.find((path) => path.toLowerCase().endsWith('.pptx'))
  if (!savedPath) throw new Error('Saved PPTX path was not recorded')
  const saveDeadline = Date.now() + 120_000
  let savedBytes
  let previousSize = -1
  while (Date.now() < saveDeadline) {
    const size = (await stat(savedPath)).size
    const bytes = await readFile(savedPath)
    const hasEndOfCentralDirectory = bytes.lastIndexOf(Buffer.from('PK\x05\x06', 'binary')) >= 0
    if (hasEndOfCentralDirectory && size === previousSize) {
      savedBytes = bytes
      break
    }
    previousSize = size
    await sleep(250)
  }
  if (!savedBytes) throw new Error('Saved PPTX never reached a complete stable ZIP state')
  await copyFile(savedPath, outputDeck)
  await slidesPage.screenshot({ path: join(evidenceDir, '12-luna-max-saved.png') })

  const report = {
    packagedApp: appBundle,
    login: { loggedIn: account.loggedIn },
    model: settings.providers.codex.model,
    reasoningEffort: settings.providers.codex.reasoningEffort,
    state: 'COMMITTED',
    slideCount: deck.slides.length,
    slides: deck.slides.map((slide, index) => ({
      title: expectedTitles[index],
      editableNodes: slide.editableNodes,
      nodeTypes: slide.nodeTypes,
      evidenceLinked: deck.notes[index]?.includes('[GenOffice Evidence]') ?? false,
      textPreview: slide.text.slice(0, 240),
    })),
    outputDeck,
  }
  await writeFile(
    join(evidenceDir, 'luna-max-evidence-smoke.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(childOutput)
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // The process group may already have exited.
    }
    await sleep(500)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The process group may already have exited.
    }
  }
  await rm(root, { recursive: true, force: true })
}
