import { describe, expect, it } from 'vitest'
import { JobLifecycle } from '@genoffice/agent-core'
import {
  acceptsSlidesJobCallback,
  createSlidesJobMetadata,
  deckRevision,
  transitionSlidesJob,
} from '../src/renderer/ai/slides-job'

describe('Slides AI lifecycle adapter', () => {
  it('uses content-free deck revision metadata', () => {
    const revision = deckRevision([{ text: 'confidential body' }])
    const metadata = createSlidesJobMetadata({
      jobId: 'job-1',
      model: 'gpt-5.6-pro',
      reasoning: 'max',
      sourceHash: revision,
    })
    expect(metadata.sources[0]?.hash).toBe(revision)
    expect(JSON.stringify(metadata)).not.toContain('confidential body')
  })

  it('rejects callbacks after the cancellation generation changes', () => {
    const lifecycle = new JobLifecycle(
      createSlidesJobMetadata({
        jobId: 'job-2',
        model: 'gpt-5.6-pro',
        reasoning: 'max',
        sourceHash: 'revision:1:a',
      }),
    )
    transitionSlidesJob(lifecycle, 'PREPARING')
    transitionSlidesJob(lifecycle, 'RUNNING')
    expect(acceptsSlidesJobCallback(lifecycle, 1, 1)).toBe(true)
    expect(acceptsSlidesJobCallback(lifecycle, 1, 2)).toBe(false)
  })
})
