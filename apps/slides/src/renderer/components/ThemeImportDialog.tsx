import { useEffect, useRef, useState } from 'react'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { ThemeImportPreview } from '../../shared/ipc'
import { useI18n } from '../i18n/locale'
import { themeImportErrorKey } from '../i18n/strings-import'

const COLOR_KEYS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
]

export function trapThemeImportFocus(
  dialog: HTMLElement | null,
  active: Element | null,
  shift: boolean,
): boolean {
  const focusable = [
    ...(dialog?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select') ?? []),
  ].filter((element) => !element.disabled)
  if (!focusable.length) return false
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (shift && active === first) {
    last.focus()
    return true
  }
  if (!shift && active === last) {
    first.focus()
    return true
  }
  return false
}

export function ThemeImportDialog({
  preview,
  onClose,
  onApplied,
}: {
  preview: ThemeImportPreview
  onClose: () => void
  onApplied: (slides: RenderSlide[], name: string) => void
}) {
  const { t } = useI18n()
  const [candidateId, setCandidateId] = useState(preview.defaultCandidateId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exhausted, setExhausted] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)
  const candidate =
    preview.candidates.find((item) => item.id === candidateId) ?? preview.candidates[0]!

  busyRef.current = busy
  const trapFocus = (
    event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'target' | 'preventDefault'>,
  ) => {
    if (event.key !== 'Tab') return
    if (trapThemeImportFocus(dialogRef.current, document.activeElement, event.shiftKey))
      event.preventDefault()
  }
  useEffect(() => {
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) onClose()
        return
      }
      if (event.key === 'Tab') {
        trapFocus(event)
        return
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.key === 'Delete' ||
        event.key === 'Backspace' ||
        event.key === 'F5'
      ) {
        event.preventDefault()
      }
    }
    document.addEventListener('keydown', keydown, true)
    return () => document.removeEventListener('keydown', keydown, true)
  }, [onClose])

  const apply = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.slidesApi.applyImportedTheme({
        token: preview.token,
        candidateId,
      })
      if (result && Array.isArray(result)) {
        onApplied(result, candidate.name)
        return
      }
      setBusy(false)
      busyRef.current = false
      setExhausted(true)
      setError(
        `${result ? t(themeImportErrorKey(result.error)) : t('themeImportApplyFailed')} ${t('themeImportPickAgain')}`,
      )
    } catch {
      setBusy(false)
      busyRef.current = false
      setExhausted(true)
      setError(`${t('themeImportErrorApplyFailed')} ${t('themeImportPickAgain')}`)
    }
  }

  return (
    <div className="theme-import-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="theme-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-import-title"
        aria-busy={busy}
      >
        <header>
          <div>
            <h2 id="theme-import-title">{t('themeImportTitle')}</h2>
            <p>{preview.sourceName}</p>
          </div>
          <button
            ref={closeRef}
            className="theme-import-close"
            aria-label={t('themeImportCancel')}
            disabled={busy}
            onClick={() => {
              if (!busyRef.current) onClose()
            }}
          >
            ×
          </button>
        </header>
        <p className="theme-import-scope">{t('themeImportScope')}</p>
        {preview.candidates.length > 1 && (
          <p className="theme-import-warning">{t('themeImportMultiWarning')}</p>
        )}
        <label>
          <span>{t('themeImportDesign')}</span>
          <select
            value={candidateId}
            disabled={busy}
            onChange={(event) => setCandidateId(event.target.value)}
          >
            {preview.candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {t('themeImportSlideCount', { count: item.slideCount })}
              </option>
            ))}
          </select>
        </label>
        <div className="theme-import-fonts">
          <div>
            <strong>{t('themeImportHeadingFont')}</strong>
            <span>{candidate.majorEaFont ?? candidate.majorFont ?? '—'}</span>
          </div>
          <div>
            <strong>{t('themeImportBodyFont')}</strong>
            <span>{candidate.minorEaFont ?? candidate.minorFont ?? '—'}</span>
          </div>
        </div>
        <div className="theme-import-swatches">
          {COLOR_KEYS.map((key) => (
            <div className="theme-import-swatch" key={key}>
              <span
                className="theme-import-color"
                style={{ backgroundColor: candidate.colors[key] }}
                aria-hidden="true"
              />
              <span>{key}</span>
              <code>{candidate.colors[key]}</code>
            </div>
          ))}
        </div>
        <div className="theme-import-error" role="alert" aria-live="assertive">
          {error}
        </div>
        <footer>
          <button disabled={busy} onClick={onClose}>
            {t('themeImportCancel')}
          </button>
          <button className="primary" disabled={busy || exhausted} onClick={() => void apply()}>
            {busy ? t('themeImportApplying') : t('themeImportApply')}
          </button>
        </footer>
      </section>
    </div>
  )
}
