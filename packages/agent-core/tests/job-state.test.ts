import { describe, expect, it } from 'vitest'
import { JobLifecycle, type JobMetadata } from '../src'

const metadata = (): JobMetadata => ({
  jobId: 'job-1',
  sessionId: 'session-1',
  proposalId: 'proposal-1',
  appKind: 'sheets',
  model: 'gpt-test',
  reasoning: 'high',
  sources: [{ locator: 'sheet:Summary!A1:D8', hash: 'sha256:source' }],
  maximumBudget: { amount: 2_000, unit: 'tokens' },
})

function clock() {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 9, 0, 0, tick++))
}

describe('JobLifecycle', () => {
  it('runs the review-before-apply flow through commit and restore', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    const queued = lifecycle.snapshot

    expect(lifecycle.transition('PREPARING').state).toBe('PREPARING')
    expect(lifecycle.transition('RUNNING').state).toBe('RUNNING')
    expect(lifecycle.transition('REVIEW_READY').state).toBe('REVIEW_READY')
    expect(lifecycle.transition('APPLYING').state).toBe('APPLYING')
    expect(lifecycle.transition('COMMITTED').state).toBe('COMMITTED')
    expect(lifecycle.transition('RESTORED')).toMatchObject({ state: 'RESTORED', version: 6 })
    expect(queued).toMatchObject({ state: 'QUEUED', version: 0 })
    expect(Object.isFrozen(queued)).toBe(true)
    expect(Object.isFrozen(queued.metadata)).toBe(true)
    expect(Object.isFrozen(queued.metadata.sources)).toBe(true)
    expect(Object.isFrozen(queued.metadata.sources[0])).toBe(true)
  })

  it('completes a read-only run without entering review', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')
    lifecycle.transition('RUNNING')

    expect(lifecycle.transition('COMPLETED').state).toBe('COMPLETED')
  })

  it('supports a direct snapshot-backed mutation that is restored on stop', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')
    lifecycle.transition('RUNNING')
    lifecycle.transition('APPLYING')

    expect(lifecycle.transition('RESTORED').state).toBe('RESTORED')
  })

  it('fails closed on an invalid transition without changing the snapshot', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    const before = lifecycle.snapshot

    expect(() => lifecycle.transition('COMMITTED')).toThrow(
      'Invalid job transition: QUEUED -> COMMITTED.',
    )
    expect(lifecycle.snapshot).toBe(before)
  })

  it('rejects a late commit after cancellation', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')
    lifecycle.transition('RUNNING')
    lifecycle.transition('REVIEW_READY')
    const cancelled = lifecycle.transition('CANCELLED')

    expect(() => lifecycle.transition('COMMITTED')).toThrow(
      'Invalid job transition: CANCELLED -> COMMITTED.',
    )
    expect(lifecycle.snapshot).toBe(cancelled)
  })

  it('does not interrupt an atomic apply after it starts', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')
    lifecycle.transition('RUNNING')
    lifecycle.transition('REVIEW_READY')
    lifecycle.transition('APPLYING')

    expect(() => lifecycle.transition('CANCELLED')).toThrow(
      'Invalid job transition: APPLYING -> CANCELLED.',
    )
    expect(lifecycle.transition('COMMITTED').state).toBe('COMMITTED')
  })

  it('stops a proposal when its source changed', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')
    lifecycle.transition('RUNNING')
    lifecycle.transition('REVIEW_READY')

    expect(lifecycle.transition('SOURCE_CHANGED').state).toBe('SOURCE_CHANGED')
    expect(() => lifecycle.transition('APPLYING')).toThrow(
      'Invalid job transition: SOURCE_CHANGED -> APPLYING.',
    )
  })

  it('blocks work before running when the maximum budget cannot be honored', () => {
    const lifecycle = new JobLifecycle(metadata(), clock())
    lifecycle.transition('PREPARING')

    expect(lifecycle.transition('BUDGET_BLOCKED').state).toBe('BUDGET_BLOCKED')
    expect(() => lifecycle.transition('RUNNING')).toThrow(
      'Invalid job transition: BUDGET_BLOCKED -> RUNNING.',
    )
  })

  it('rejects content-bearing or unbounded metadata', () => {
    const withContents = { ...metadata(), documentContents: 'private document text' }
    expect(() => new JobLifecycle(withContents as JobMetadata)).toThrow(
      'Job metadata contains unsupported field documentContents.',
    )
    expect(
      () => new JobLifecycle({ ...metadata(), sources: new Array(33).fill(metadata().sources[0]) }),
    ).toThrow('Job metadata sources must be an array with at most 32 items.')
  })
})
