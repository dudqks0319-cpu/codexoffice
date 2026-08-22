import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const codexEntrypoint = resolve(repoRoot, 'node_modules/@openai/codex/bin/codex.js')
const child = spawn(process.execPath, [codexEntrypoint, 'app-server', '--listen', 'stdio://'], {
  cwd: repoRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let nextId = 1
let output = ''
let stderr = ''
const pending = new Map()

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request(method, params) {
  const id = nextId++
  write({ id, method, params })
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`Timed out waiting for ${method}`))
    }, 20_000)
    pending.set(id, { resolvePromise, rejectPromise, timer })
  })
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  let newline = output.indexOf('\n')
  while (newline >= 0) {
    const line = output.slice(0, newline).trim()
    output = output.slice(newline + 1)
    if (line) {
      const message = JSON.parse(line)
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.rejectPromise(new Error(message.error.message ?? 'RPC error'))
        else entry.resolvePromise(message.result)
      }
    }
    newline = output.indexOf('\n')
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-8_000)
})

try {
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('spawn', resolvePromise)
    child.once('error', rejectPromise)
  })
  await request('initialize', {
    clientInfo: { name: 'codexoffice-model-smoke', title: 'Codexoffice Model Smoke', version: '0.1.0' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  })
  write({ method: 'initialized' })

  const account = await request('account/read', { refreshToken: false })
  const models = []
  let cursor = null
  do {
    const page = await request('model/list', { cursor, limit: 100, includeHidden: false })
    if (!Array.isArray(page?.data)) throw new Error('Invalid model/list response')
    models.push(...page.data)
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
  } while (cursor)

  console.log(
    JSON.stringify(
      {
        account: {
          type: account?.account?.type ?? null,
          authMethod: account?.account?.type === 'chatgpt' ? 'chatgpt' : null,
        },
        models: models.map((model) => ({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          hidden: model.hidden,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
        })),
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(String(error))
  if (stderr.trim()) console.error(stderr.trim())
  process.exitCode = 1
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  child.stdin.end()
  child.kill('SIGTERM')
}
