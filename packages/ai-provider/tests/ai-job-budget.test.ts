import { describe, expect, it } from 'vitest'
import {
  AiJobBudgetError,
  createAiJobBudgetGate,
  estimateAiStreamInputTokens,
  estimateAiStreamOutputTokens,
} from '../src/ai-job-budget'

const fixedGate = () =>
  createAiJobBudgetGate({
    capability: () => 'main-issued-secret',
    maximumOutputTokens: 8,
    maximumInputTokens: 20,
    maximumProviderTurns: 3,
    maximumTurnOutputTokens: 4,
  })

describe('AI job budget gate', () => {
  it('binds an opaque ticket to one sender and rejects cross-sender use', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender-a', 'job-1')
    expect(ticket).toEqual({
      jobId: 'job-1',
      capability: 'main-issued-secret',
      maximumOutputTokens: 8,
    })
    expect(() => gate.acquireTurn('sender-b', ticket, 'r1', 1, 4)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'invalid-ticket' }),
    )
  })

  it('caps every provider turn and cumulative output, settling only observed output', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender', 'job-1')
    const first = gate.acquireTurn('sender', ticket, 'r1', 2, 100)
    expect(first.maxTokens).toBe(4)
    first.settle({ providerStarted: true, completed: true, outputTokens: 2 })
    const second = gate.acquireTurn('sender', ticket, 'r2', 2, 100)
    expect(second.maxTokens).toBe(4)
    second.settle({ providerStarted: true, completed: false })
    const third = gate.acquireTurn('sender', ticket, 'r3', 2, 100)
    expect(third.maxTokens).toBe(2)
    third.settle({ providerStarted: true, completed: true, outputTokens: 2 })
    expect(() => gate.acquireTurn('sender', ticket, 'r4', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'turn-limit' }),
    )
  })

  it('charges cumulative input and rolls back a reservation when paid work never starts', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender', 'job-1')
    const unused = gate.acquireTurn('sender', ticket, 'r1', 20, 1)
    unused.settle({ providerStarted: false, completed: false })
    const paid = gate.acquireTurn('sender', ticket, 'r2', 20, 1)
    paid.settle({ providerStarted: true, completed: true, outputTokens: 1 })
    expect(() => gate.acquireTurn('sender', ticket, 'r3', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'budget' }),
    )
  })

  it('rejects replay after explicit end or replacement by a new job', () => {
    const gate = fixedGate()
    const first = gate.begin('sender', 'job-1')
    gate.end('sender', first)
    expect(() => gate.acquireTurn('sender', first, 'r1', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'invalid-ticket' }),
    )
    const second = gate.begin('sender', 'job-2')
    gate.begin('sender', 'job-3')
    expect(() => gate.acquireTurn('sender', second, 'r2', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'invalid-ticket' }),
    )
  })

  it('rejects overlapping turns for the same job', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender', 'job-1')
    const first = gate.acquireTurn('sender', ticket, 'r1', 1, 1)
    expect(() => gate.acquireTurn('sender', ticket, 'r2', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'duplicate' }),
    )
    first.settle({ providerStarted: false, completed: false })
  })

  it('does not let a new job invalidate an in-flight paid turn', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender', 'job-1')
    const active = gate.acquireTurn('sender', ticket, 'r1', 1, 1)
    expect(() => gate.begin('sender', 'job-2')).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'duplicate' }),
    )
    gate.end('sender', ticket)
    expect(() => gate.begin('sender', 'job-2')).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'duplicate' }),
    )
    active.settle({ providerStarted: true, completed: true, outputTokens: 1 })
    expect(gate.begin('sender', 'job-2').jobId).toBe('job-2')
  })

  it('terminally blocks a job when observed output exceeds its reservation', () => {
    const gate = fixedGate()
    const ticket = gate.begin('sender', 'job-1')
    const lease = gate.acquireTurn('sender', ticket, 'r1', 1, 4)
    lease.settle({ providerStarted: true, completed: true, outputTokens: 5 })
    expect(() => gate.acquireTurn('sender', ticket, 'r2', 1, 1)).toThrowError(
      expect.objectContaining<Partial<AiJobBudgetError>>({ code: 'invalid-ticket' }),
    )
  })
})

describe('AI job token estimates', () => {
  it('counts text, tool schemas/results, and images without copying image base64', () => {
    const small = estimateAiStreamInputTokens({
      system: 'system',
      messages: [{ role: 'user', text: 'hello' }],
      tools: [],
    })
    const rich = estimateAiStreamInputTokens({
      system: 'system',
      messages: [
        { role: 'user', text: 'hello', images: [{ mime: 'image/png', base64: 'A'.repeat(1_000) }] },
        { role: 'tool', results: [{ id: '1', name: 'read', output: 'x'.repeat(400) }] },
      ],
      tools: [{ name: 'read', description: 'd', inputSchema: { type: 'object' } }],
    })
    expect(rich).toBeGreaterThan(small + 4_000)
    expect(estimateAiStreamOutputTokens('abcd', [])).toBeGreaterThan(0)
    expect(
      estimateAiStreamOutputTokens('abcd', [{ id: '1', name: 'read', input: { path: 'x' } }]),
    ).toBeGreaterThan(estimateAiStreamOutputTokens('abcd', []))
  })
})
