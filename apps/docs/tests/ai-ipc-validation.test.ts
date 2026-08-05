import { describe, expect, it } from 'vitest'
import { parseAiStreamRequest } from '@genoffice/ai-provider'
import { AGENT_TOOLS } from '../src/renderer/ai/tools'

describe('Docs AI IPC schema integration', () => {
  it('accepts the complete shipped tool set', () => {
    const request = parseAiStreamRequest({
      requestId: 'docs-test',
      settings: {},
      system: '',
      messages: [],
      tools: AGENT_TOOLS,
    })
    expect(request.tools).toHaveLength(AGENT_TOOLS.length)
  })
})
