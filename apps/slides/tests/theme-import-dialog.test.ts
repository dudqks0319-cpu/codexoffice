import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThemeImportDialog,
  trapThemeImportFocus,
} from '../src/renderer/components/ThemeImportDialog'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/renderer/i18n/locale', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const preview = {
  token: 'token',
  sourceName: 'safe.pptx',
  defaultCandidateId: 'one',
  candidates: [
    {
      id: 'one',
      name: 'Theme',
      slideCount: 2,
      colors: Object.fromEntries(
        [
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
        ].map((key) => [key, '#123456']),
      ),
      majorFont: 'Latin Heading',
      minorFont: 'Latin Body',
      majorEaFont: '한국어 제목',
      minorEaFont: '한국어 본문',
    },
  ],
}

const renderDialog = (onClose = vi.fn(), onApplied = vi.fn()) =>
  createRoot(host).render(React.createElement(ThemeImportDialog, { preview, onClose, onApplied }))

let host: HTMLDivElement
describe('ThemeImportDialog accessibility', () => {
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    host.remove()
    vi.restoreAllMocks()
  })

  it('focuses inside, traps Tab, exposes EA fonts, and Escape cancels', async () => {
    const close = vi.fn()
    window.slidesApi = { applyImportedTheme: vi.fn() } as unknown as typeof window.slidesApi
    await act(async () => renderDialog(close))
    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('themeImportCancel')
    expect(host.textContent).toContain('한국어 제목')
    const buttons = host.querySelectorAll('button')
    const applyButton = buttons[buttons.length - 1] as HTMLButtonElement
    applyButton.focus()
    expect(trapThemeImportFocus(dialog as HTMLElement, applyButton, false)).toBe(true)
    expect(document.activeElement).toBe(buttons[0])
    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('prevents double apply and requires a fresh picker after failure', async () => {
    const close = vi.fn()
    let resolveApply!: (value: { error: 'apply-failed' }) => void
    const applyImportedTheme = vi.fn(
      () =>
        new Promise<{ error: 'apply-failed' }>((resolve) => {
          resolveApply = resolve
        }),
    )
    window.slidesApi = { applyImportedTheme } as unknown as typeof window.slidesApi
    await act(async () => renderDialog(close))
    const closeButton = host.querySelector('button') as HTMLButtonElement
    const apply = [...host.querySelectorAll('button')].at(-1) as HTMLButtonElement
    await act(async () => {
      apply.click()
      apply.click()
      closeButton.click()
    })
    expect(applyImportedTheme).toHaveBeenCalledOnce()
    expect(closeButton.disabled).toBe(true)
    expect(close).not.toHaveBeenCalled()
    await act(async () => resolveApply({ error: 'apply-failed' }))
    expect(apply.disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('themeImportPickAgain')
  })

  it('stops editing shortcuts from reaching the app behind the modal', async () => {
    const globalShortcut = vi.fn()
    window.addEventListener('keydown', globalShortcut)
    window.slidesApi = { applyImportedTheme: vi.fn() } as unknown as typeof window.slidesApi
    await act(async () => renderDialog())
    const shortcut = new window.KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(shortcut)
    expect(shortcut.defaultPrevented).toBe(true)
    expect(globalShortcut).not.toHaveBeenCalled()
    window.removeEventListener('keydown', globalShortcut)
  })
})
