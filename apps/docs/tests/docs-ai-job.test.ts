import { describe, expect, it } from 'vitest'
import { JobLifecycle } from '@genoffice/agent-core'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import {
  acceptsJobCallback,
  affectedUnitsForTool,
  createDocsJobMetadata,
  createDocsProposal,
  createIsolatedProposalEditor,
  persistedToolActivity,
  proposalSourceMatches,
  transitionCurrentJob,
} from '../src/renderer/ai/docs-job'

function lifecycle(): JobLifecycle {
  return new JobLifecycle(
    createDocsJobMetadata({
      jobId: 'job-1',
      proposalId: 'proposal-1',
      model: 'gpt-5',
      reasoning: 'medium',
      sourceHash: 'revision:1:abc',
    }),
  )
}

describe('Docs AI job adapter', () => {
  it('rejects callbacks from cancelled and superseded runs', () => {
    const job = lifecycle()
    transitionCurrentJob(job, 'PREPARING')
    transitionCurrentJob(job, 'RUNNING')
    expect(acceptsJobCallback(job, 3, 3)).toBe(true)

    transitionCurrentJob(job, 'CANCELLED')
    expect(acceptsJobCallback(job, 3, 3)).toBe(false)
    expect(acceptsJobCallback(job, 2, 3)).toBe(false)
    expect(transitionCurrentJob(job, 'REVIEW_READY')).toBeNull()
  })

  it('fails closed when the source changed before apply and preserves recovery data in memory', () => {
    const before = { type: 'doc', content: [{ type: 'paragraph', text: 'before' }] }
    const after = { type: 'doc', content: [{ type: 'paragraph', text: 'after' }] }
    const proposal = createDocsProposal({
      proposalId: 'proposal-1',
      before,
      after,
      affectedUnits: ['Block 0'],
    })

    expect(proposalSourceMatches(proposal, before)).toBe(true)
    expect(proposalSourceMatches(proposal, { ...before, changed: true })).toBe(false)
    expect(proposal.before).toEqual(before)
    expect(proposal.after).toEqual(after)
  })

  it('runs proposal mutations in isolation from the live document and undo history', () => {
    const source = new Editor({
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [{ type: 'docParagraph', attrs: { docxIndex: 0 } }],
      },
    })
    const before = source.getJSON()
    const proposalEditor = createIsolatedProposalEditor(source, before)

    proposalEditor.commands.insertContent('proposal text')

    expect(source.getJSON()).toEqual(before)
    expect(proposalEditor.getText()).toContain('proposal text')
    expect(source.commands.undo()).toBe(false)
    proposalEditor.destroy()
    source.destroy()
  })

  it('keeps tool payloads out of persisted chat activity', () => {
    const persisted = persistedToolActivity([
      {
        name: 'replace_blocks',
        summary: 'Replaced blocks 0-1',
        input: '{"html":"secret document text"}',
        output: 'secret tool output',
      },
    ])

    expect(persisted).toEqual([{ name: 'replace_blocks', summary: 'replace blocks' }])
    expect(JSON.stringify(persisted)).not.toContain('secret')
  })

  it('derives content-free affected units without retaining mutation payloads', () => {
    expect(
      affectedUnitsForTool({
        name: 'replace_blocks',
        input: { startBlockIndex: 2, endBlockIndex: 4, html: '<p>private</p>' },
      }),
    ).toEqual(['Blocks 2-4'])
  })
})
