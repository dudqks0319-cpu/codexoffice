import type { JobLifecycle, JobMetadata, JobSnapshot, JobState } from '@genoffice/agent-core'

export const SLIDES_AI_MAXIMUM_BUDGET = 8_192

export function deckRevision(deck: unknown): string {
  const serialized = JSON.stringify(deck)
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `revision:${serialized.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function createSlidesJobMetadata(args: {
  readonly jobId: string
  readonly sessionId?: string
  readonly model: string
  readonly reasoning: string
  readonly sourceHash: string
}): JobMetadata {
  return {
    jobId: args.jobId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    appKind: 'slides',
    model: args.model,
    reasoning: args.reasoning,
    sources: [
      {
        locator: args.sessionId ? 'presentation:open' : 'presentation:unsaved',
        hash: args.sourceHash,
      },
    ],
    maximumBudget: { amount: SLIDES_AI_MAXIMUM_BUDGET, unit: 'output tokens' },
  }
}

export function transitionSlidesJob(
  lifecycle: JobLifecycle | null,
  next: JobState,
): JobSnapshot | null {
  if (!lifecycle) return null
  try {
    return lifecycle.transition(next)
  } catch {
    return null
  }
}

export function acceptsSlidesJobCallback(
  lifecycle: JobLifecycle | null,
  generation: number,
  currentGeneration: number,
  allowedStates: readonly JobState[] = ['PREPARING', 'RUNNING', 'APPLYING'],
): boolean {
  return (
    lifecycle !== null &&
    generation === currentGeneration &&
    allowedStates.includes(lifecycle.snapshot.state)
  )
}
