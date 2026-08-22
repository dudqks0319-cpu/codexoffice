import { describe, expect, it } from 'vitest'
import { parseAiStreamRequest } from '@genoffice/ai-provider'
import { createSlidesSkill } from '../src/renderer/ai/slides-skill'

describe('Slides AI IPC schema integration', () => {
  it('accepts the complete shipped nullable and referenced tool schemas', () => {
    const tools = createSlidesSkill({
      getSlides: () => [],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide: () => undefined,
      applyDeck: () => undefined,
      fitWidthPx: 1280,
    }).tools
    expect(
      parseAiStreamRequest({
        requestId: 'slides-test',
        job: { jobId: 'slides-job', capability: 'main-issued-secret', maximumOutputTokens: 8_192 },
        settings: {},
        system: '',
        messages: [],
        tools,
      }).tools,
    ).toHaveLength(tools.length)
  })
})
