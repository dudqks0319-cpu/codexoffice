import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AiRequestGateError,
  createAiRequestGate,
  createAiTurnController,
  runIfAiTurnActive,
} from '../src/request-gate'
import { withAiRequestLedger } from '../src/request-ledger'

describe('AI request gate', () => {
  it('rejects duplicate active IDs and releases idempotently', () => {
    const gate = createAiRequestGate({ isDisabled: () => false })
    const lease = gate.acquire('same', 10)
    expect(() => gate.acquire('same', 10)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'duplicate' }),
    )
    lease.release()
    lease.release()
    expect(() => gate.acquire('same', 10)).not.toThrow()
  })

  it('enforces concurrency independent of request ID rotation', () => {
    const gate = createAiRequestGate({ isDisabled: () => false, maxConcurrent: 1 })
    const lease = gate.acquire('a', 1)
    expect(() => gate.acquire('b', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'concurrency' }),
    )
    lease.release()
  })

  it('enforces burst and daily token budgets at their boundaries', () => {
    let time = 1_000
    const burst = createAiRequestGate({
      now: () => time,
      isDisabled: () => false,
      maxBurstRequests: 2,
      maxRollingRequests: 10,
      maxDailyRequests: 10,
    })
    burst.acquire('a', 1).release()
    burst.acquire('b', 1).release()
    expect(() => burst.acquire('c', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'rate-limit' }),
    )
    time += 60_001
    expect(() => burst.acquire('c', 1)).not.toThrow()

    const daily = createAiRequestGate({
      isDisabled: () => false,
      maxDailyTokens: 10,
      maxDailyRequests: 10,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
    })
    daily.acquire('x', 10).release()
    expect(() => daily.acquire('y', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )
  })

  it('fails closed when the server-side kill switch is active', () => {
    const gate = createAiRequestGate({ isDisabled: () => true })
    expect(() => gate.acquire('a', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'disabled' }),
    )
  })

  it('persists request and token budgets across gate instances without storing request content', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const options = {
      userDataDir,
      isDisabled: () => false,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
      maxDailyRequests: 10,
      maxDailyTokens: 10,
    }
    createAiRequestGate(options).acquire('prompt contains private@example.com', 7).release()
    const restarted = createAiRequestGate(options)
    expect(() => restarted.acquire('new-process-request', 4)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )

    const ledger = await readFile(join(userDataDir, 'ai-request-ledger.json'), 'utf8')
    expect(ledger).not.toContain('prompt contains')
    expect(ledger).not.toContain('private@example.com')
    expect(JSON.parse(ledger)).toMatchObject({ version: 1, events: [{ tokens: 7 }] })
  })

  it('serializes independent gates so they cannot overspend one ledger', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const options = {
      userDataDir,
      isDisabled: () => false,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
      maxDailyRequests: 10,
      maxDailyTokens: 10,
    }
    const first = createAiRequestGate(options)
    const second = createAiRequestGate(options)
    first.acquire('first', 6).release()
    expect(() => second.acquire('second', 5)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )
  })

  it('prunes persisted usage after the configured day rolls over', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    let time = 1_000
    const options = {
      userDataDir,
      now: () => time,
      isDisabled: () => false,
      dailyWindowMs: 1_000,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
      maxDailyRequests: 1,
    }
    createAiRequestGate(options).acquire('day-one', 1).release()
    expect(() => createAiRequestGate(options).acquire('same-day', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )
    time += 1_001
    expect(() => createAiRequestGate(options).acquire('day-two', 1)).not.toThrow()
  })

  it('rolls back an unused reservation but release keeps consumed usage charged', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const options = {
      userDataDir,
      isDisabled: () => false,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
      maxDailyRequests: 1,
    }
    const gate = createAiRequestGate(options)
    const unused = gate.acquire('unused', 5)
    unused.rollback()
    unused.rollback()
    const paid = gate.acquire('paid', 5)
    paid.release()
    paid.rollback()
    expect(() => createAiRequestGate(options).acquire('after-paid', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )
  })

  it('fails closed for malformed, unsafe, or unavailable ledgers', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const ledgerPath = join(userDataDir, 'ai-request-ledger.json')
    await writeFile(ledgerPath, '{broken', { mode: 0o600 })
    const gate = createAiRequestGate({ ledgerPath, isDisabled: () => false })
    expect(() => gate.acquire('blocked', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'ledger-unavailable' }),
    )

    await writeFile(ledgerPath, JSON.stringify({ version: 1, events: [] }))
    await chmod(userDataDir, 0o500)
    try {
      expect(() => gate.acquire('cannot-write', 1)).toThrowError(
        expect.objectContaining<Partial<AiRequestGateError>>({ code: 'ledger-unavailable' }),
      )
    } finally {
      await chmod(userDataDir, 0o700)
    }
  })

  it('writes the ledger with owner-only permissions', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    createAiRequestGate({ userDataDir, isDisabled: () => false })
      .acquire('safe', 1)
      .release()
    const { mode } = await stat(join(userDataDir, 'ai-request-ledger.json'))
    expect(mode & 0o777).toBe(0o600)
  })

  it('preserves a stale-looking lock while its recorded process is alive', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const ledgerPath = join(userDataDir, 'ai-request-ledger.json')
    const lockPath = `${ledgerPath}.lock`
    mkdirSync(lockPath, { mode: 0o700 })
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), createdAt: 0 }),
      { mode: 0o600 },
    )
    utimesSync(lockPath, new Date(0), new Date(0))

    try {
      const gate = createAiRequestGate({
        ledgerPath,
        ledgerLockTimeoutMs: 10,
        ledgerStaleLockMs: 1,
        isDisabled: () => false,
      })
      expect(() => gate.acquire('blocked-by-live-owner', 1)).toThrowError(
        expect.objectContaining<Partial<AiRequestGateError>>({ code: 'ledger-unavailable' }),
      )
      expect(existsSync(lockPath)).toBe(true)
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  })

  it('reclaims an old PID-less lock left between mkdir and owner creation', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const ledgerPath = join(userDataDir, 'ai-request-ledger.json')
    const lockPath = `${ledgerPath}.lock`
    mkdirSync(lockPath, { mode: 0o700 })
    utimesSync(lockPath, new Date(0), new Date(0))

    expect(() =>
      createAiRequestGate({
        ledgerPath,
        ledgerLockTimeoutMs: 10,
        ledgerStaleLockMs: 1,
        isDisabled: () => false,
      }).acquire('after-crashed-owner', 1),
    ).not.toThrow()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('reclaims a stale lock whose recorded process no longer exists', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const ledgerPath = join(userDataDir, 'ai-request-ledger.json')
    const lockPath = `${ledgerPath}.lock`
    mkdirSync(lockPath, { mode: 0o700 })
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ version: 1, pid: 2_147_483_647, token: randomUUID(), createdAt: 0 }),
      { mode: 0o600 },
    )
    utimesSync(lockPath, new Date(0), new Date(0))

    expect(() =>
      createAiRequestGate({
        ledgerPath,
        ledgerLockTimeoutMs: 10,
        ledgerStaleLockMs: 1,
        isDisabled: () => false,
      }).acquire('after-dead-owner', 1),
    ).not.toThrow()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('does not release a replacement lock when ownership changes during a transaction', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-ai-ledger-'))
    const ledgerPath = join(userDataDir, 'ai-request-ledger.json')
    const lockPath = `${ledgerPath}.lock`
    const replacementToken = randomUUID()

    const result = withAiRequestLedger({ path: ledgerPath }, (events) => {
      rmSync(lockPath, { recursive: true, force: true })
      mkdirSync(lockPath, { mode: 0o700 })
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          token: replacementToken,
          createdAt: Date.now(),
        }),
        { mode: 0o600 },
      )
      return { result: 'completed', events }
    })

    try {
      expect(result).toBe('completed')
      expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
        token: replacementToken,
      })
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  })

  it('aborts a continuously active turn at the absolute deadline and cleans up the timer', () => {
    vi.useFakeTimers()
    const deadline = createAiTurnController(100)
    vi.advanceTimersByTime(99)
    expect(deadline.controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.controller.signal.aborted).toBe(true)
    expect(deadline.timedOut).toBe(true)
    deadline.release()
    vi.useRealTimers()
  })

  it('does not start paid work when the sender disappears during an async preflight', async () => {
    const controller = new AbortController()
    let finishPreflight!: () => void
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const paidWork = vi.fn(async () => undefined)
    const flow = (async () => {
      await preflight
      return runIfAiTurnActive(controller.signal, () => true, paidWork)
    })()
    controller.abort()
    finishPreflight()
    await expect(flow).resolves.toBe(false)
    expect(paidWork).not.toHaveBeenCalled()
  })
})
