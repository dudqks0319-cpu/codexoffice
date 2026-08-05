import { describe, expect, it } from 'vitest'
import {
  AI_MAX_TOKENS,
  AiRequestValidationError,
  parseAiChatRequest,
  parseAiRequestId,
  parseAiStreamRequest,
} from '../src/ipc-validation'

const valid = () => ({
  requestId: 'req-1',
  settings: { attacker: 'ignored' },
  system: 'system',
  messages: [{ role: 'user', text: 'hello' }],
  tools: [{ name: 'edit_doc', description: 'edit', inputSchema: { type: 'object' } }],
  maxTokens: 8192,
})

describe('AI IPC validation', () => {
  it('accepts boundary token values and ignores the settings shape', () => {
    expect(parseAiStreamRequest({ ...valid(), maxTokens: 1 }).maxTokens).toBe(1)
    expect(parseAiStreamRequest({ ...valid(), maxTokens: AI_MAX_TOKENS }).maxTokens).toBe(
      AI_MAX_TOKENS,
    )
  })

  it.each([0, AI_MAX_TOKENS + 1, 1.5, Number.NaN])('rejects invalid maxTokens %s', (maxTokens) => {
    expect(() => parseAiStreamRequest({ ...valid(), maxTokens })).toThrow(AiRequestValidationError)
  })

  it('rejects oversized strings, images, schemas, unknown keys, and prototype keys', () => {
    expect(() => parseAiStreamRequest({ ...valid(), system: 'x'.repeat(65_537) })).toThrow()
    expect(() =>
      parseAiStreamRequest({
        ...valid(),
        messages: [{ role: 'user', text: '', images: [{ mime: 'image/svg+xml', base64: 'AAAA' }] }],
      }),
    ).toThrow()
    expect(() =>
      parseAiStreamRequest({
        ...valid(),
        tools: [{ name: 'x', description: '', inputSchema: { constructor: {} } }],
      }),
    ).toThrow()
    expect(() => parseAiStreamRequest({ ...valid(), extra: true })).toThrow()
  })

  it('validates chat and cancellation payloads', () => {
    expect(parseAiChatRequest({ settings: {}, system: 's', user: 'u' })).toEqual({
      system: 's',
      user: 'u',
    })
    expect(parseAiRequestId('req:1')).toBe('req:1')
    expect(() => parseAiRequestId('../bad')).toThrow()
  })
})
