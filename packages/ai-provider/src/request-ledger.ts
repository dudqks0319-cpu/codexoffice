import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AiRequestLedgerEvent {
  id: string
  at: number
  tokens: number
}

export type AiRequestAuditReason =
  'reserved' | 'disabled' | 'duplicate' | 'concurrency' | 'rate-limit' | 'daily-limit'

export interface AiRequestAuditEvent {
  id: string
  at: number
  tokens: number
  decision: 'allow' | 'deny'
  reason: AiRequestAuditReason
}

interface AiRequestLedgerDocument {
  version: 2
  events: AiRequestLedgerEvent[]
  audit: AiRequestAuditEvent[]
}

const MAX_LEDGER_EVENTS = 100_000
const MAX_AUDIT_EVENTS = 10_000
const sleepArray = new Int32Array(new SharedArrayBuffer(4))
const lockOwnerFile = 'owner.json'

interface LedgerLockOwner {
  version: 1
  pid: number
  token: string
  createdAt: number
}

function failClosed(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause })
}

function parseLedger(raw: string): AiRequestLedgerDocument {
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) {
    throw failClosed('AI request ledger is corrupt')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw failClosed('AI request ledger is corrupt', error)
  }
  if (!value || typeof value !== 'object') throw failClosed('AI request ledger is corrupt')
  const record = value as Record<string, unknown>
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.events)) {
    throw failClosed('AI request ledger is corrupt')
  }
  if (record.events.length > MAX_LEDGER_EVENTS) throw failClosed('AI request ledger is corrupt')
  const ids = new Set<string>()
  const events = record.events.map((event) => {
    if (!event || typeof event !== 'object') throw failClosed('AI request ledger is corrupt')
    const item = event as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(item.id) ||
      !Number.isSafeInteger(item.at) ||
      (item.at as number) < 0 ||
      !Number.isSafeInteger(item.tokens) ||
      (item.tokens as number) < 0
    ) {
      throw failClosed('AI request ledger is corrupt')
    }
    if (ids.has(item.id)) throw failClosed('AI request ledger is corrupt')
    ids.add(item.id)
    return { id: item.id, at: item.at as number, tokens: item.tokens as number }
  })
  if (record.version === 1) return { version: 2, events, audit: [] }
  if (!Array.isArray(record.audit) || record.audit.length > MAX_AUDIT_EVENTS) {
    throw failClosed('AI request ledger is corrupt')
  }
  const auditIds = new Set<string>()
  const allowedReasons = new Set<AiRequestAuditReason>([
    'reserved',
    'disabled',
    'duplicate',
    'concurrency',
    'rate-limit',
    'daily-limit',
  ])
  const audit = record.audit.map((event) => {
    if (!event || typeof event !== 'object') throw failClosed('AI request ledger is corrupt')
    const item = event as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(item.id) ||
      !Number.isSafeInteger(item.at) ||
      (item.at as number) < 0 ||
      !Number.isSafeInteger(item.tokens) ||
      (item.tokens as number) < 0 ||
      (item.decision !== 'allow' && item.decision !== 'deny') ||
      typeof item.reason !== 'string' ||
      !allowedReasons.has(item.reason as AiRequestAuditReason)
    ) {
      throw failClosed('AI request ledger is corrupt')
    }
    if (auditIds.has(item.id)) throw failClosed('AI request ledger is corrupt')
    auditIds.add(item.id)
    return {
      id: item.id,
      at: item.at as number,
      tokens: item.tokens as number,
      decision: item.decision as AiRequestAuditEvent['decision'],
      reason: item.reason as AiRequestAuditReason,
    }
  })
  return { version: 2, events, audit }
}

function assertRegularFile(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw failClosed('AI request ledger is unsafe')
}

function writeAtomic(path: string, document: AiRequestLedgerDocument): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(document)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    chmodSync(path, 0o600)
    fd = openSync(path, 'r')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    const parentFd = openSync(directory, 'r')
    try {
      fsyncSync(parentFd)
    } finally {
      closeSync(parentFd)
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
    throw failClosed('AI request ledger write failed', error)
  }
}

function readLockOwner(lockPath: string): LedgerLockOwner | undefined {
  try {
    const ownerPath = join(lockPath, lockOwnerFile)
    const stat = lstatSync(ownerPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    const value = JSON.parse(readFileSync(ownerPath, 'utf8')) as Partial<LedgerLockOwner>
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.token !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.token) ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0
    ) {
      return undefined
    }
    return value as LedgerLockOwner
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function removeLockOwnedBy(lockPath: string, token: string): boolean {
  const owner = readLockOwner(lockPath)
  if (owner?.token !== token) return false
  try {
    unlinkSync(join(lockPath, lockOwnerFile))
    rmdirSync(lockPath)
    return true
  } catch {
    return false
  }
}

function removeStaleLock(lockPath: string, staleLockMs: number): boolean {
  try {
    const lockStat = lstatSync(lockPath)
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return false
    if (Date.now() - lockStat.mtimeMs <= staleLockMs) return false

    const owner = readLockOwner(lockPath)
    if (owner) {
      if (isProcessAlive(owner.pid)) return false
      return removeLockOwnedBy(lockPath, owner.token)
    }

    // A process can die after mkdir and before writing its owner record. Only
    // an old, empty directory is safe to reclaim without an ownership token.
    rmdirSync(lockPath)
    return true
  } catch {
    return false
  }
}

export interface AiRequestLedgerOptions {
  path: string
  lockTimeoutMs?: number
  staleLockMs?: number
}

/** Synchronous, process-safe ledger transaction used by the synchronous request gate API. */
export function withAiRequestLedger<T>(
  options: AiRequestLedgerOptions,
  update: (
    events: AiRequestLedgerEvent[],
    audit: AiRequestAuditEvent[],
  ) => { result: T; events?: AiRequestLedgerEvent[]; audit?: AiRequestAuditEvent[] },
): T {
  const lockPath = `${options.path}.lock`
  const deadline = Date.now() + (options.lockTimeoutMs ?? 2_000)
  const staleLockMs = options.staleLockMs ?? 30_000
  const owner: LedgerLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  }
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      try {
        writeFileSync(join(lockPath, lockOwnerFile), `${JSON.stringify(owner)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
      } catch (error) {
        try {
          rmdirSync(lockPath)
        } catch {
          // Preserve an unexpected replacement or non-empty lock.
        }
        throw failClosed('AI request ledger lock unavailable', error)
      }
      break
    } catch (error) {
      if (removeStaleLock(lockPath, staleLockMs)) continue
      if (Date.now() >= deadline) throw failClosed('AI request ledger is busy', error)
      Atomics.wait(sleepArray, 0, 0, 5)
    }
  }
  let updating = false
  try {
    assertRegularFile(options.path)
    const document = existsSync(options.path)
      ? parseLedger(readFileSync(options.path, 'utf8'))
      : { version: 2 as const, events: [], audit: [] }
    updating = true
    const transaction = update(document.events, document.audit)
    updating = false
    if (transaction.events || transaction.audit) {
      writeAtomic(options.path, {
        version: 2,
        events: transaction.events ?? document.events,
        audit: transaction.audit ?? document.audit,
      })
    }
    return transaction.result
  } catch (error) {
    if (updating) throw error
    if (error instanceof Error && error.message.startsWith('AI request ledger')) throw error
    throw failClosed('AI request ledger unavailable', error)
  } finally {
    removeLockOwnedBy(lockPath, owner.token)
  }
}
