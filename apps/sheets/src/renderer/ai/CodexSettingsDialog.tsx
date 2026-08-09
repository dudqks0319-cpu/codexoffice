import { useEffect, useRef, useState } from 'react'
import type { AiSettings, CodexModelSummary, CodexReasoningEffort } from '@genoffice/ai-provider'
import { CODEX_MODEL_MAX_LENGTH, CODEX_REASONING_EFFORTS } from '../../shared/ai-settings'
import { useI18n } from '../i18n/locale'

export function CodexSettingsDialog({
  open,
  settings,
  onClose,
  onSave,
}: {
  readonly open: boolean
  readonly settings: AiSettings
  readonly onClose: () => void
  readonly onSave: (settings: AiSettings) => Promise<void>
}): React.JSX.Element | null {
  const { t } = useI18n()
  const model = settings.providers.codex.model
  const reasoningEffort = settings.providers.codex.reasoningEffort ?? 'low'
  const [draft, setDraft] = useState(model)
  const [reasoningDraft, setReasoningDraft] = useState<CodexReasoningEffort>(reasoningEffort)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<readonly CodexModelSummary[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setDraft(model)
    setReasoningDraft(reasoningEffort)
    setError(null)
    setModels([])
    setModelsError(false)
    setModelsLoading(true)
    void window.desktopApi
      .aiCodexModels()
      .then((available) => {
        if (!cancelled) setModels(available)
      })
      .catch(() => {
        if (!cancelled) setModelsError(true)
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false)
      })
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !savingRef.current) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [model, onClose, open, reasoningEffort])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const nextModel = draft.trim()
    if (nextModel.length > CODEX_MODEL_MAX_LENGTH) {
      setError(`Model ID must be ${CODEX_MODEL_MAX_LENGTH} characters or fewer.`)
      return
    }
    setSaving(true)
    savingRef.current = true
    setError(null)
    try {
      const nextSettings: AiSettings = {
        ...settings,
        providers: {
          ...settings.providers,
          codex: {
            ...settings.providers.codex,
            model: nextModel,
            reasoningEffort: reasoningDraft,
          },
        },
      }
      await onSave(nextSettings)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save AI settings.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <div
        className="modal ai-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="codex-settings-title">{t('aiSettingsTitle')}</h2>
        <section className="ai-model-picker" aria-label={t('aiModel')}>
          <div className="ai-model-picker-heading">
            <h3>{t('aiModel')}</h3>
            {!modelsLoading && models.length > 0 && (
              <span className="ai-model-count">{models.length}</span>
            )}
          </div>
          {modelsLoading && <p className="ai-model-status">{t('aiAccountChecking')}</p>}
          {!modelsLoading && modelsError && (
            <p className="ai-model-status ai-model-status-error">{t('aiUnknownError')}</p>
          )}
          {!modelsLoading && models.length > 0 && (
            <div className="ai-model-options">
              {models.map((available) => (
                <label
                  className={`ai-model-option${draft === available.model ? ' selected' : ''}`}
                  key={available.id}
                  data-model-id={available.model}
                >
                  <input
                    type="radio"
                    name="codex-model"
                    value={available.model}
                    checked={draft === available.model}
                    onChange={() => setDraft(available.model)}
                  />
                  <span className="ai-model-copy">
                    <span className="ai-model-name-row">
                      <strong>{available.displayName}</strong>
                      {available.isDefault && <span className="ai-model-default">Default</span>}
                    </span>
                    <span className="ai-model-description">{available.description}</span>
                  </span>
                  <span className="ai-model-check" aria-hidden="true">
                    {draft === available.model ? '✓' : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>
        <fieldset className="ai-reasoning-picker">
          <legend>Reasoning effort</legend>
          <div className="ai-reasoning-options">
            {CODEX_REASONING_EFFORTS.map((effort) => (
              <label
                className={`ai-reasoning-option${reasoningDraft === effort ? ' selected' : ''}`}
                key={effort}
              >
                <input
                  type="radio"
                  name="codex-reasoning-effort"
                  value={effort}
                  checked={reasoningDraft === effort}
                  onChange={() => setReasoningDraft(effort)}
                />
                {effort}
              </label>
            ))}
          </div>
          <p className="ai-settings-hint">
            max reserves the largest reasoning budget for the hardest quality-first tasks.
          </p>
        </fieldset>
        <label htmlFor="codex-model-input">
          Model ID
          <input
            ref={inputRef}
            id="codex-model-input"
            value={draft}
            maxLength={CODEX_MODEL_MAX_LENGTH}
            placeholder="default (Codex SDK)"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="codex-model-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </label>
        <p id="codex-model-hint" className="ai-settings-hint">
          {t('aiModelHint')}
        </p>
        {error && (
          <p className="ai-settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            {t('aiCancel')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? '…' : t('aiSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
