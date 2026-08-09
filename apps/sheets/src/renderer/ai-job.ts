import type { JobLifecycle } from '@genoffice/agent-core'

export function acceptsSheetsJobCallback(
  lifecycle: JobLifecycle | null,
  generation: number,
  currentGeneration: number,
): boolean {
  const state = lifecycle?.snapshot.state
  return (
    generation === currentGeneration &&
    (state === 'PREPARING' || state === 'RUNNING' || state === 'REVIEW_READY')
  )
}
