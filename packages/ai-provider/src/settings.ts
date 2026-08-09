import type { AiSettings, CodexReasoningEffort } from './types'
import { defaultAiSettings } from './providers'

/** Maximum length accepted for a Codex model identifier. */
export const CODEX_MODEL_MAX_LENGTH = 128
export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly CodexReasoningEffort[]

const CODEX_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize an optional model override before it reaches the Codex SDK. */
export function normalizeCodexModel(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('Codex model must be a string.')
  const model = value.trim()
  if (!model) return ''
  if (model.length > CODEX_MODEL_MAX_LENGTH || !CODEX_MODEL_PATTERN.test(model)) {
    throw new Error('Invalid Codex model.')
  }
  return model
}

export function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort {
  if (value === undefined || value === null || value === '') return 'low'
  if (
    typeof value !== 'string' ||
    !CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort)
  ) {
    throw new Error('Invalid Codex reasoning effort.')
  }
  return value as CodexReasoningEffort
}

export function codexAiSettingsWithModel(
  model: string,
  reasoningEffort: unknown = 'low',
): AiSettings {
  const settings = defaultAiSettings()
  settings.providers.codex.model = normalizeCodexModel(model)
  settings.providers.codex.reasoningEffort = normalizeCodexReasoningEffort(reasoningEffort)
  return settings
}

/**
 * Normalize stored settings to the Codex-only configuration used by the
 * current app surfaces. Other provider fields are intentionally discarded so
 * renderer-supplied API keys never become part of the active configuration.
 */
export function normalizeCodexSettings(input: unknown): AiSettings {
  const record = isRecord(input) ? input : {}
  const providers = isRecord(record.providers) ? record.providers : {}
  const codex = isRecord(providers.codex) ? providers.codex : {}
  const legacyModel = record.model
  const model = normalizeCodexModel(codex.model ?? legacyModel)
  const reasoningEffort = normalizeCodexReasoningEffort(codex.reasoningEffort)
  return codexAiSettingsWithModel(model, reasoningEffort)
}

/**
 * Validate the renderer-to-main shape before normalizing it. The provider
 * keys themselves are ignored, but bounded field checks prevent oversized or
 * malformed values from crossing the IPC boundary.
 */
export function parseCodexSettingsInput(input: unknown): AiSettings {
  if (!isRecord(input) || input.provider !== 'codex' || !isRecord(input.providers)) {
    throw new Error('Invalid AI settings.')
  }
  const codex = input.providers.codex
  if (!isRecord(codex)) throw new Error('Invalid AI settings.')
  if (
    codex.apiKey !== undefined &&
    (typeof codex.apiKey !== 'string' || codex.apiKey.length > 4096)
  ) {
    throw new Error('Invalid AI settings.')
  }
  if (
    codex.baseUrl !== undefined &&
    (typeof codex.baseUrl !== 'string' || codex.baseUrl.length > 2048)
  ) {
    throw new Error('Invalid AI settings.')
  }
  if (
    codex.reasoningEffort !== undefined &&
    (typeof codex.reasoningEffort !== 'string' || codex.reasoningEffort.length > 16)
  ) {
    throw new Error('Invalid AI settings.')
  }
  return normalizeCodexSettings(input)
}

/** Invalid on-disk settings fail closed to the SDK default model. */
export function restoreCodexSettings(input: unknown): AiSettings {
  try {
    return normalizeCodexSettings(input)
  } catch {
    return codexAiSettingsWithModel('')
  }
}

/** Persist only the non-sensitive Codex settings supported by the UI today. */
export function serializableCodexSettings(settings: AiSettings): {
  provider: 'codex'
  providers: {
    codex: { apiKey: ''; model: string; reasoningEffort: CodexReasoningEffort }
  }
} {
  return {
    provider: 'codex',
    providers: {
      codex: {
        apiKey: '',
        model: normalizeCodexModel(settings.providers.codex.model),
        reasoningEffort: normalizeCodexReasoningEffort(settings.providers.codex.reasoningEffort),
      },
    },
  }
}
