import { describe, expect, it } from 'vitest'
import { parseAiStreamRequest } from '@genoffice/ai-provider'
import {
  normalizeCodexModel,
  normalizeSheetsAiSettings,
  restoreSheetsAiSettings,
  serializableSheetsAiSettings,
} from '../src/main/ai-settings'
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

  it('keeps the SDK default when the model override is blank', () => {
    const settings = normalizeSheetsAiSettings({
      provider: 'codex',
      providers: { codex: { apiKey: '', model: '  ', reasoningEffort: 'xhigh' } },
    })
    expect(settings.providers.codex.model).toBe('')
    expect(settings.providers.codex.reasoningEffort).toBe('xhigh')
  })

  it('accepts bounded model identifiers and rejects control text', () => {
    expect(normalizeCodexModel('gpt-5-codex')).toBe('gpt-5-codex')
    expect(() => normalizeCodexModel('model with spaces')).toThrow('Invalid Codex model.')
    expect(() => normalizeCodexModel('a'.repeat(129))).toThrow('Invalid Codex model.')
  })

  it('drops renderer-supplied provider keys before persistence', () => {
    const settings = normalizeSheetsAiSettings({
      provider: 'codex',
      providers: {
        codex: {
          apiKey: 'renderer-secret',
          model: 'gpt-5-codex',
          reasoningEffort: 'high',
        },
        openai: { apiKey: 'other-secret', model: 'gpt-4.1' },
      },
    })
    expect(serializableSheetsAiSettings(settings)).toEqual({
      provider: 'codex',
      providers: {
        codex: { apiKey: '', model: 'gpt-5-codex', reasoningEffort: 'high' },
      },
    })
  })

  it('restores max and fails closed for invalid persisted settings', () => {
    expect(
      restoreSheetsAiSettings({ providers: { codex: { model: 'bad model' } } }).providers.codex
        .model,
    ).toBe('')
    expect(
      restoreSheetsAiSettings({ providers: { codex: { reasoningEffort: 'max' } } }).providers.codex
        .reasoningEffort,
    ).toBe('max')
    expect(
      restoreSheetsAiSettings({ providers: { codex: { reasoningEffort: 'unbounded' } } }).providers
        .codex.reasoningEffort,
    ).toBe('low')
  })
})
