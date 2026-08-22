import { describe, expect, it } from 'vitest'
import {
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  parseCodexSettingsInput,
  restoreCodexSettings,
  serializableCodexSettings,
} from '../src/settings'

describe('Codex settings normalization', () => {
  it('keeps a bounded model override and discards renderer secrets', () => {
    const settings = parseCodexSettingsInput({
      provider: 'codex',
      providers: {
        codex: {
          apiKey: 'renderer-secret',
          model: 'gpt-5-codex',
          reasoningEffort: 'xhigh',
        },
        openai: { apiKey: 'other-secret', model: 'gpt-4.1' },
      },
    })

    expect(serializableCodexSettings(settings)).toEqual({
      provider: 'codex',
      providers: {
        codex: { apiKey: '', model: 'gpt-5-codex', reasoningEffort: 'xhigh' },
      },
    })
  })

  it('uses the SDK default when the model is blank', () => {
    expect(
      restoreCodexSettings({ providers: { codex: { model: '  ' } } }).providers.codex.model,
    ).toBe('')
  })

  it('rejects malformed IPC input and model control text', () => {
    expect(() => parseCodexSettingsInput({ provider: 'openai', providers: {} })).toThrow(
      'Invalid AI settings.',
    )
    expect(() => normalizeCodexModel('model with spaces')).toThrow('Invalid Codex model.')
    expect(() => normalizeCodexModel('a'.repeat(129))).toThrow('Invalid Codex model.')
    expect(normalizeCodexReasoningEffort('xhigh')).toBe('xhigh')
    expect(normalizeCodexReasoningEffort('max')).toBe('max')
    expect(() => normalizeCodexReasoningEffort('unbounded')).toThrow(
      'Invalid Codex reasoning effort.',
    )
  })

  it('fails closed for corrupted persisted settings', () => {
    expect(
      restoreCodexSettings({ providers: { codex: { model: 'bad model' } } }).providers.codex,
    ).toMatchObject({ model: '', reasoningEffort: 'low' })
  })
})
