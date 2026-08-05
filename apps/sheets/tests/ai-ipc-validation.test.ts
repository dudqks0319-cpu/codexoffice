import { describe, expect, it } from 'vitest'
import { parseAiStreamRequest } from '@genoffice/ai-provider'
import { WORKBOOK_TOOLS } from '../src/renderer/ai/tools'

describe('Sheets AI IPC schema integration', () => {
  it('accepts the complete shipped tool set', () => {
    expect(
      parseAiStreamRequest({
        requestId: 'sheets-test',
        settings: {},
        system: '',
        messages: [],
        tools: WORKBOOK_TOOLS,
      }).tools,
    ).toHaveLength(WORKBOOK_TOOLS.length)
  })
})
