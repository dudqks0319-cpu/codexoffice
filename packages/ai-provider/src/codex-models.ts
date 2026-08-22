import os from 'node:os'
import { CodexAppServerClient, type CodexAppServerClientLike } from './codex-app-server'
import { codexChildEnvironment, resolveCodexExecutable } from './codex-executable'
import type { CodexModelSummary } from './types'

const MODEL_LIST_LIMIT = 100
const MODEL_LIST_CACHE_MS = 60_000
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

export interface CodexModelDependencies {
  resolveExecutable?: () => string
  createClient?: (
    options: ConstructorParameters<typeof CodexAppServerClient>[0],
  ) => CodexAppServerClientLike
  cwd?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
}

function normalizeModel(value: unknown): CodexModelSummary | null {
  if (!record(value)) return null
  const id = boundedString(value.id, 128)
  const model = boundedString(value.model, 128)
  const displayName = boundedString(value.displayName, 128)
  const description = boundedString(value.description, 512)
  const defaultReasoningEffort = boundedString(value.defaultReasoningEffort, 32)
  if (
    !id ||
    !model ||
    !displayName ||
    !description ||
    !defaultReasoningEffort ||
    !MODEL_ID_PATTERN.test(id) ||
    !MODEL_ID_PATTERN.test(model) ||
    typeof value.hidden !== 'boolean' ||
    typeof value.isDefault !== 'boolean'
  ) {
    return null
  }
  return {
    id,
    model,
    displayName,
    description,
    defaultReasoningEffort,
    hidden: value.hidden,
    isDefault: value.isDefault,
  }
}

function appServerArgs(): readonly string[] {
  return [
    'app-server',
    '--strict-config',
    '--listen',
    'stdio://',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'history.persistence="none"',
    '-c',
    'mcp_servers={}',
    '-c',
    'plugins={}',
    '-c',
    'hooks={}',
  ]
}

async function readCodexModels(overrides?: CodexModelDependencies): Promise<CodexModelSummary[]> {
  const executable = (overrides?.resolveExecutable ?? resolveCodexExecutable)()
  const client = (overrides?.createClient ?? ((options) => new CodexAppServerClient(options)))({
    executable,
    args: appServerArgs(),
    cwd: overrides?.cwd ?? os.tmpdir(),
    env: codexChildEnvironment(),
  })
  try {
    await client.start()
    const account = await client.request('account/read', { refreshToken: false })
    if (!record(account) || !record(account.account) || account.account.type !== 'chatgpt') {
      throw new Error('Codex is not signed in')
    }

    const models: CodexModelSummary[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = await client.request('model/list', {
        cursor,
        limit: MODEL_LIST_LIMIT - models.length,
        includeHidden: false,
      })
      if (!record(page) || !Array.isArray(page.data)) {
        throw new Error('Codex returned an invalid model list')
      }
      for (const entry of page.data) {
        const model = normalizeModel(entry)
        if (!model || model.hidden || seen.has(model.model)) continue
        seen.add(model.model)
        models.push(model)
        if (models.length >= MODEL_LIST_LIMIT) break
      }
      cursor =
        models.length < MODEL_LIST_LIMIT && typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : null
    } while (cursor)
    return models
  } finally {
    await client.stop().catch(() => {})
  }
}

let cachedModels: { expiresAt: number; value: CodexModelSummary[] } | undefined
let modelsInFlight: Promise<CodexModelSummary[]> | undefined

export async function listCodexModels(
  overrides?: CodexModelDependencies,
): Promise<CodexModelSummary[]> {
  if (overrides) return readCodexModels(overrides)
  if (cachedModels && cachedModels.expiresAt > Date.now()) return cachedModels.value
  if (modelsInFlight) return modelsInFlight
  modelsInFlight = readCodexModels().then((value) => {
    cachedModels = { expiresAt: Date.now() + MODEL_LIST_CACHE_MS, value }
    return value
  })
  try {
    return await modelsInFlight
  } finally {
    modelsInFlight = undefined
  }
}
