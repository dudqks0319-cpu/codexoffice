import { spawn } from 'node:child_process'
import { codexChildEnvironment, resolveCodexExecutable } from './codex-executable'
import type { CodexAccountStatus } from './types'

const MAX_CLI_OUTPUT_BYTES = 64 * 1024
const STATUS_TIMEOUT_MS = 10_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const LOGOUT_TIMEOUT_MS = 15_000
const STATUS_CACHE_MS = 5_000
const FILE_AUTH_CONFIG_ARGS = ['-c', 'cli_auth_credentials_store="file"'] as const

export interface CodexAuthDependencies {
  resolveExecutable?: () => string
  runCli?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<CliResult>
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function runCli(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: codexChildEnvironment(),
      signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_CLI_OUTPUT_BYTES) return
      stdout.push(chunk.subarray(0, MAX_CLI_OUTPUT_BYTES - stdoutBytes))
      stdoutBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_CLI_OUTPUT_BYTES) return
      stderr.push(chunk.subarray(0, MAX_CLI_OUTPUT_BYTES - stderrBytes))
      stderrBytes += chunk.length
    })
    child.once('error', reject)
    child.once('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function dependencies(overrides?: CodexAuthDependencies) {
  return {
    resolveExecutable: overrides?.resolveExecutable ?? resolveCodexExecutable,
    runCli: overrides?.runCli ?? runCli,
  }
}

async function runCliBounded(
  deps: ReturnType<typeof dependencies>,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<CliResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  externalSignal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, timeoutMs)
  try {
    return await Promise.race([
      deps.runCli(executable, args, controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(externalSignal?.aborted ? 'cancelled' : 'timed out')),
          { once: true },
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

function normalizedCliError(operation: 'status' | 'login' | 'logout', result?: CliResult): Error {
  const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.toLowerCase()
  if (text.includes('not logged in') || text.includes('not authenticated')) {
    return new Error('Codex is not signed in')
  }
  if (text.includes('network') || text.includes('connection') || text.includes('timed out')) {
    return new Error(`Codex ${operation} failed because the authentication service is unavailable`)
  }
  if (text.includes('denied') || text.includes('unauthorized') || text.includes('401')) {
    return new Error(`Codex ${operation} was not authorized`)
  }
  return new Error(`Codex ${operation} failed`)
}

function redactedCause(error: unknown): Error {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name) ? error.name : 'Error'
  return new Error(`Redacted Codex CLI ${name}`)
}

async function readCodexAccountStatus(
  overrides?: CodexAuthDependencies,
): Promise<CodexAccountStatus> {
  const deps = dependencies(overrides)
  let result: CliResult
  try {
    result = await runCliBounded(
      deps,
      deps.resolveExecutable(),
      [...FILE_AUTH_CONFIG_ARGS, 'login', 'status'],
      STATUS_TIMEOUT_MS,
    )
  } catch (error) {
    // Raw CLI errors can contain credentials; retain only a deliberately redacted cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Codex status failed', { cause: redactedCause(error) })
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) {
    if (/not logged in|not authenticated/i.test(output)) return { loggedIn: false }
    throw normalizedCliError('status', result)
  }
  if (/logged in using chatgpt/i.test(output)) return { loggedIn: true, authMethod: 'chatgpt' }
  if (/logged in using (an )?api key/i.test(output))
    return { loggedIn: true, authMethod: 'api-key' }
  if (/logged in|authenticated/i.test(output)) return { loggedIn: true, authMethod: 'unknown' }
  return { loggedIn: false }
}

let cachedStatus: { expiresAt: number; value: CodexAccountStatus } | undefined
let statusInFlight: Promise<CodexAccountStatus> | undefined

export async function getCodexAccountStatus(
  overrides?: CodexAuthDependencies,
): Promise<CodexAccountStatus> {
  if (overrides) return readCodexAccountStatus(overrides)
  if (cachedStatus && cachedStatus.expiresAt > Date.now()) return cachedStatus.value
  if (statusInFlight) return statusInFlight
  statusInFlight = readCodexAccountStatus().then((value) => {
    cachedStatus = { expiresAt: Date.now() + STATUS_CACHE_MS, value }
    return value
  })
  try {
    return await statusInFlight
  } finally {
    statusInFlight = undefined
  }
}

let loginInFlight = false

export async function loginCodex(
  signal?: AbortSignal,
  overrides?: CodexAuthDependencies,
): Promise<CodexAccountStatus> {
  if (loginInFlight) throw new Error('A Codex sign-in is already in progress')
  loginInFlight = true
  try {
    const deps = dependencies(overrides)
    const executable = deps.resolveExecutable()
    const result = await runCliBounded(
      deps,
      executable,
      [...FILE_AUTH_CONFIG_ARGS, 'login'],
      LOGIN_TIMEOUT_MS,
      signal,
    )
    if (result.code !== 0) throw normalizedCliError('login', result)
    return getCodexAccountStatus({ ...overrides, resolveExecutable: () => executable })
  } catch (error) {
    if (signal?.aborted) {
      // Raw CLI errors can contain credentials; retain only a deliberately redacted cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Codex sign-in was cancelled', { cause: redactedCause(error) })
    }
    if (error instanceof Error && error.message.startsWith('Codex ')) throw error
    // Raw CLI errors can contain credentials; retain only a deliberately redacted cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Codex login failed', { cause: redactedCause(error) })
  } finally {
    cachedStatus = undefined
    loginInFlight = false
  }
}

export async function logoutCodex(overrides?: CodexAuthDependencies): Promise<void> {
  const deps = dependencies(overrides)
  try {
    const result = await runCliBounded(
      deps,
      deps.resolveExecutable(),
      [...FILE_AUTH_CONFIG_ARGS, 'logout'],
      LOGOUT_TIMEOUT_MS,
    )
    if (result.code !== 0) throw normalizedCliError('logout', result)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Codex ')) throw error
    // Raw CLI errors can contain credentials; retain only a deliberately redacted cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Codex logout failed', { cause: redactedCause(error) })
  } finally {
    cachedStatus = undefined
  }
}
