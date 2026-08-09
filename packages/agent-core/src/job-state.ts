export const JOB_STATES = [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'REVIEW_READY',
  'APPLYING',
  'COMMITTED',
  'COMPLETED',
  'RESTORED',
  'CANCELLED',
  'TIMED_OUT',
  'BUDGET_BLOCKED',
  'FAILED',
  'RECOVERY_REQUIRED',
  'SOURCE_CHANGED',
] as const

export type JobState = (typeof JOB_STATES)[number]

export const INTERRUPTED_JOB_STATES = [
  'CANCELLED',
  'TIMED_OUT',
  'BUDGET_BLOCKED',
  'FAILED',
  'RECOVERY_REQUIRED',
  'SOURCE_CHANGED',
] as const satisfies readonly JobState[]

export type InterruptedJobState = (typeof INTERRUPTED_JOB_STATES)[number]

export interface JobSource {
  readonly locator: string
  readonly hash: string
}

export interface JobBudget {
  readonly amount: number
  readonly unit: string
}

/**
 * Deliberately content-free metadata safe to retain with an in-session job.
 * Runtime validation rejects unknown fields rather than silently retaining them.
 */
export interface JobMetadata {
  readonly jobId: string
  readonly sessionId?: string | undefined
  readonly proposalId?: string | undefined
  readonly appKind: string
  readonly model: string
  readonly reasoning: string
  readonly sources: readonly JobSource[]
  readonly maximumBudget: JobBudget
}

export interface JobSnapshot {
  readonly state: JobState
  readonly metadata: Readonly<JobMetadata>
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type JobClock = () => Date

const DEFAULT_CLOCK: JobClock = () => new Date()
const MAX_SOURCES = 32

const NEXT_STATES: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ['PREPARING', 'CANCELLED', 'TIMED_OUT', 'BUDGET_BLOCKED', 'FAILED', 'SOURCE_CHANGED'],
  PREPARING: ['RUNNING', 'CANCELLED', 'TIMED_OUT', 'BUDGET_BLOCKED', 'FAILED', 'SOURCE_CHANGED'],
  RUNNING: [
    'REVIEW_READY',
    'APPLYING',
    'COMPLETED',
    'CANCELLED',
    'TIMED_OUT',
    'BUDGET_BLOCKED',
    'FAILED',
    'RECOVERY_REQUIRED',
    'SOURCE_CHANGED',
  ],
  REVIEW_READY: [
    'APPLYING',
    'CANCELLED',
    'TIMED_OUT',
    'BUDGET_BLOCKED',
    'FAILED',
    'SOURCE_CHANGED',
  ],
  APPLYING: ['COMMITTED', 'RESTORED', 'FAILED', 'RECOVERY_REQUIRED', 'SOURCE_CHANGED'],
  COMMITTED: ['RESTORED'],
  COMPLETED: [],
  RESTORED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  BUDGET_BLOCKED: [],
  FAILED: [],
  RECOVERY_REQUIRED: [],
  SOURCE_CHANGED: [],
}

const METADATA_KEYS = new Set([
  'jobId',
  'sessionId',
  'proposalId',
  'appKind',
  'model',
  'reasoning',
  'sources',
  'maximumBudget',
])

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new TypeError(`${label} contains unsupported field ${unknown}.`)
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new RangeError(`${label} must contain 1-${maximumLength} characters.`)
  }
  return normalized
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximumLength)
}

function sanitizeMetadata(input: JobMetadata): Readonly<JobMetadata> {
  assertRecord(input, 'Job metadata')
  rejectUnknownKeys(input, METADATA_KEYS, 'Job metadata')

  if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) {
    throw new RangeError(`Job metadata sources must be an array with at most ${MAX_SOURCES} items.`)
  }
  const sources = input.sources.map((source, index) => {
    assertRecord(source, `Source ${index}`)
    rejectUnknownKeys(source, new Set(['locator', 'hash']), `Source ${index}`)
    return Object.freeze({
      locator: boundedString(source.locator, `Source ${index} locator`, 512),
      hash: boundedString(source.hash, `Source ${index} hash`, 256),
    })
  })

  assertRecord(input.maximumBudget, 'Maximum budget')
  rejectUnknownKeys(input.maximumBudget, new Set(['amount', 'unit']), 'Maximum budget')
  if (
    typeof input.maximumBudget.amount !== 'number' ||
    !Number.isFinite(input.maximumBudget.amount) ||
    input.maximumBudget.amount < 0 ||
    input.maximumBudget.amount > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('Maximum budget amount must be a finite non-negative safe number.')
  }
  const maximumBudget = Object.freeze({
    amount: input.maximumBudget.amount,
    unit: boundedString(input.maximumBudget.unit, 'Maximum budget unit', 32),
  })

  return Object.freeze({
    jobId: boundedString(input.jobId, 'Job ID', 128),
    ...optionalProperty('sessionId', optionalBoundedString(input.sessionId, 'Session ID', 128)),
    ...optionalProperty('proposalId', optionalBoundedString(input.proposalId, 'Proposal ID', 128)),
    appKind: boundedString(input.appKind, 'App kind', 32),
    model: boundedString(input.model, 'Model', 128),
    reasoning: boundedString(input.reasoning, 'Reasoning', 32),
    sources: Object.freeze(sources),
    maximumBudget,
  })
}

function optionalProperty<Key extends string>(key: Key, value: string | undefined) {
  return value === undefined ? {} : { [key]: value }
}

function timestamp(clock: JobClock): string {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Job clock must return a valid Date.')
  }
  return value.toISOString()
}

function freezeSnapshot(snapshot: JobSnapshot): JobSnapshot {
  return Object.freeze(snapshot)
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return NEXT_STATES[from].includes(to)
}

export function isInterruptedJobState(state: JobState): state is InterruptedJobState {
  return (INTERRUPTED_JOB_STATES as readonly JobState[]).includes(state)
}

/**
 * Owns the current snapshot so callbacks arriving after cancellation cannot advance a stale branch.
 */
export class JobLifecycle {
  #snapshot: JobSnapshot

  constructor(
    metadata: JobMetadata,
    private readonly clock: JobClock = DEFAULT_CLOCK,
  ) {
    const now = timestamp(clock)
    this.#snapshot = freezeSnapshot({
      state: 'QUEUED',
      metadata: sanitizeMetadata(metadata),
      version: 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  get snapshot(): JobSnapshot {
    return this.#snapshot
  }

  transition(nextState: JobState): JobSnapshot {
    const current = this.#snapshot
    if (!canTransitionJob(current.state, nextState)) {
      throw new Error(`Invalid job transition: ${current.state} -> ${nextState}.`)
    }

    const updatedAt = timestamp(this.clock)
    if (updatedAt < current.updatedAt) {
      throw new Error('Job clock moved backwards.')
    }
    this.#snapshot = freezeSnapshot({
      state: nextState,
      metadata: current.metadata,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt,
    })
    return this.#snapshot
  }
}
