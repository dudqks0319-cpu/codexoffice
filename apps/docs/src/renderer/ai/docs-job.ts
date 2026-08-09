import type {
  AgentToolCall,
  JobLifecycle,
  JobMetadata,
  JobSnapshot,
  JobState,
} from '@genoffice/agent-core'
import { Editor } from '@tiptap/core'

export const DOCS_AI_MAXIMUM_BUDGET = 8_192

export interface DocsProposal<TSnapshot> {
  readonly proposalId: string
  readonly sourceRevision: string
  readonly before: TSnapshot
  readonly after: TSnapshot
  readonly affectedUnits: readonly string[]
  readonly warnings: readonly string[]
}

export interface PersistedToolActivity {
  readonly name: string
  readonly summary: string
  readonly isError?: boolean
}

/** Runs proposal tools against the same schema without touching the live editor or its undo stack. */
export function createIsolatedProposalEditor(source: Editor, snapshot: unknown): Editor {
  return new Editor({
    extensions: source.options.extensions,
    content: snapshot as never,
  })
}

/** Exact, content-bearing serialization stays in renderer memory and is used only for CAS. */
export function serializeDocumentSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot)
}

/** Content-free revision label for lifecycle metadata and the job strip. */
export function documentRevision(snapshot: unknown): string {
  const serialized = serializeDocumentSnapshot(snapshot)
  let hash = 0x811c9dc5
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `revision:${serialized.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function createDocsJobMetadata(args: {
  readonly jobId: string
  readonly proposalId: string
  readonly sessionId?: string
  readonly model: string
  readonly reasoning: string
  readonly sourceHash: string
}): JobMetadata {
  return {
    jobId: args.jobId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    proposalId: args.proposalId,
    appKind: 'docs',
    model: args.model,
    reasoning: args.reasoning,
    sources: [
      { locator: args.sessionId ? 'document:open' : 'document:unsaved', hash: args.sourceHash },
    ],
    maximumBudget: { amount: DOCS_AI_MAXIMUM_BUDGET, unit: 'tokens' },
  }
}

export function transitionCurrentJob(
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

export function acceptsJobCallback(
  lifecycle: JobLifecycle | null,
  generation: number,
  currentGeneration: number,
  allowedStates: readonly JobState[] = ['PREPARING', 'RUNNING'],
): boolean {
  return (
    lifecycle !== null &&
    generation === currentGeneration &&
    allowedStates.includes(lifecycle.snapshot.state)
  )
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function integer(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null
}

function blockRange(input: Record<string, unknown>): string | null {
  const start = integer(input.startBlockIndex)
  const end = integer(input.endBlockIndex)
  if (start === null || end === null) return null
  return start === end ? `Block ${start}` : `Blocks ${start}-${end}`
}

/** Proposal metadata only: never copies HTML, search terms, chart labels, or other document content. */
export function affectedUnitsForTool(call: Pick<AgentToolCall, 'name' | 'input'>): string[] {
  const input = record(call.input) ?? {}
  const directRange = blockRange(input)
  if (directRange) return [directRange]

  if (call.name === 'insert_content' || call.name === 'insert_chart') {
    const after = integer(input.afterBlockIndex)
    return [
      after === null ? 'Cursor position' : after < 0 ? 'Document start' : `After block ${after}`,
    ]
  }
  if (call.name === 'edit_chart') {
    const index = integer(input.blockIndex)
    return [index === null ? 'Chart block' : `Block ${index}`]
  }
  if (call.name === 'insert_image') return ['Cursor position']
  if (call.name === 'apply_commands') {
    const units = new Set<string>()
    const commands = Array.isArray(input.commands) ? input.commands : []
    for (const commandValue of commands) {
      const command = record(commandValue)
      if (!command) continue
      const body = record(Object.values(command)[0])
      const target = record(body?.target)
      const indexes = Array.isArray(target?.blockIndexes) ? target.blockIndexes : []
      for (const index of indexes) if (Number.isInteger(index)) units.add(`Block ${index}`)
      if (target?.scope === 'selection') units.add('Current selection')
    }
    return units.size > 0 ? [...units] : ['Document formatting']
  }
  return ['Document']
}

export function createDocsProposal<TSnapshot>(args: {
  readonly proposalId: string
  readonly before: TSnapshot
  readonly after: TSnapshot
  readonly affectedUnits: readonly string[]
  readonly warnings?: readonly string[]
}): DocsProposal<TSnapshot> {
  return Object.freeze({
    proposalId: args.proposalId,
    sourceRevision: serializeDocumentSnapshot(args.before),
    before: args.before,
    after: args.after,
    affectedUnits: Object.freeze([...new Set(args.affectedUnits)]),
    warnings: Object.freeze([...(args.warnings ?? [])]),
  })
}

export function proposalSourceMatches(
  proposal: Pick<DocsProposal<unknown>, 'sourceRevision'>,
  current: unknown,
): boolean {
  return proposal.sourceRevision === serializeDocumentSnapshot(current)
}

/** Project-store receives content-free activity only; input/output payloads remain in memory. */
export function persistedToolActivity(
  tools: ReadonlyArray<{
    readonly name: string
    readonly summary: string
    readonly isError?: boolean
    readonly input?: string
    readonly output?: string
  }>,
): PersistedToolActivity[] {
  return tools.map(({ name, isError }) => ({
    name,
    summary: name.replace(/[_-]+/g, ' '),
    ...(isError === undefined ? {} : { isError }),
  }))
}
