import { useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import appIcon from './assets/app-icon.png'
import { useI18n } from './locale'
import type { StringKey } from './locale'
import './onboarding.css'

interface OnboardingProps {
  /** called when the user finishes the last slide or clicks skip */
  onDone: () => void
}

interface Slide {
  titleKey: StringKey
  /** 18px dark line right under the title */
  subtitleKey: StringKey
  /** 16px muted paragraph below the title block */
  bodyKey?: StringKey
  /** render the body in the dimmer footnote gray */
  bodyDim?: boolean
  /** account slide explains the app-private Codex sign-in boundary */
  showAccountNote?: boolean
  art: 'logo' | 'terminal' | 'check'
}

const SLIDES: readonly Slide[] = [
  { titleKey: 'onbTitle1', subtitleKey: 'onbSubtitle1', bodyKey: 'onbBody1', art: 'logo' },
  { titleKey: 'onbTitle2', subtitleKey: 'onbBody2', showAccountNote: true, art: 'terminal' },
  {
    titleKey: 'onbTitle3',
    subtitleKey: 'onbBody3',
    bodyKey: 'onbNote3',
    bodyDim: true,
    art: 'check',
  },
]

/** Publisher disclosure shown before this independent app asks the user to sign in. */
const INDEPENDENT_PROJECT_NOTICE: Record<Lang, string> = {
  zh: '**独立开源项目，并非 OpenAI 产品。**',
  en: '**Independent open-source project; not an OpenAI product.**',
  ja: '**独立したオープンソースプロジェクトであり、OpenAI の製品ではありません。**',
  ko: '**독립 오픈소스 프로젝트이며 OpenAI 제품이 아닙니다.**',
  fr: '**Projet open source indépendant, non affilié à un produit OpenAI.**',
  de: '**Unabhängiges Open-Source-Projekt; kein OpenAI-Produkt.**',
  es: '**Proyecto independiente de código abierto; no es un producto de OpenAI.**',
  th: '**โครงการโอเพนซอร์สอิสระ ไม่ใช่ผลิตภัณฑ์ของ OpenAI**',
  id: '**Proyek sumber terbuka independen; bukan produk OpenAI.**',
  ru: '**Независимый проект с открытым исходным кодом; не продукт OpenAI.**',
  ar: '**مشروع مستقل مفتوح المصدر، وليس منتجًا من OpenAI.**',
  pt: '**Projeto independente de código aberto; não é um produto da OpenAI.**',
  it: '**Progetto open source indipendente; non è un prodotto OpenAI.**',
  pl: '**Niezależny projekt open source; nie jest produktem OpenAI.**',
  nl: '**Onafhankelijk opensourceproject; geen OpenAI-product.**',
  ms: '**Projek sumber terbuka bebas; bukan produk OpenAI.**',
  he: '**פרויקט קוד פתוח עצמאי; אינו מוצר של OpenAI.**',
  hi: '**स्वतंत्र ओपन-सोर्स परियोजना; यह OpenAI उत्पाद नहीं है।**',
  'zh-TW': '**獨立開源專案，並非 OpenAI 產品。**',
}

/** render `**emphasized**` segments of a localized string as <strong> */
function renderEmphasis(text: string) {
  return text
    .split('**')
    .map((part, i) => (i % 2 === 1 ? <strong key={part}>{part}</strong> : part))
}

/* exact vectors from the design spec:
 * 60px canvas, 4px strokes — same visual mass as the 60px app icon */
function SlideArt({ kind }: { kind: Slide['art'] }) {
  if (kind === 'logo') {
    return <img className="onb-art onb-art-logo" src={appIcon} alt="" />
  }
  if (kind === 'terminal') {
    return (
      <span className="onb-art onb-art-badge onb-art-terminal" aria-hidden="true">
        <svg
          viewBox="0 0 60 60"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5.5" y="8" width="49" height="44" rx="7" />
          <path d="m17 23 9 8-9 8M31 39h12" />
        </svg>
      </span>
    )
  }
  return (
    <span className="onb-art onb-art-badge onb-art-check" aria-hidden="true">
      <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" strokeWidth="4">
        <path
          d="M29.9883 5.5C43.5194 5.5 54.4883 16.469 54.4883 30C54.4883 43.5311 43.5194 54.5 29.9883 54.5C16.4573 54.5 5.48828 43.5311 5.48828 30C5.48828 16.469 16.4573 5.5 29.9883 5.5Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M18.125 33.75L24.7764 40.4014C25.8727 41.4977 27.6924 41.342 28.5865 40.0753L41.875 21.25"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

export function Onboarding({ onDone }: OnboardingProps) {
  const { lang, t } = useI18n()
  const [index, setIndex] = useState(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const slide = SLIDES[index]
  const isLast = index === SLIDES.length - 1

  const next = () => {
    if (isLast) onDone()
    else setIndex(index + 1)
  }

  // move focus into the dialog on mount so keyboard users start inside it
  // (the container, not a button, so no focus ring shows on open)
  useEffect(() => {
    cardRef.current?.focus()
  }, [])

  // slide changes can strip focus from the active control (leaving slide 2
  // can remove the active control, which blurs it) — pull focus back onto the
  // card so it never drops to body
  useEffect(() => {
    const card = cardRef.current
    const active = document.activeElement
    if (card && (!(active instanceof HTMLElement) || !card.contains(active))) card.focus()
  }, [index])

  // keyboard handling: Escape skips, Enter / ArrowRight advance, ArrowLeft goes
  // back, and Tab is trapped inside the dialog (aria-modal). Enter is ignored
  // when a button is focused so the native click doesn't double-fire.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDone()
        return
      }
      if (event.key === 'Tab') {
        const card = cardRef.current
        if (!card) return
        // inactive slides stay mounted (stacked for the height lock) but are
        // inert — their buttons must not enter the tab cycle
        const focusables = Array.from(card.querySelectorAll<HTMLElement>('button')).filter(
          (el) => !el.closest('[inert]'),
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        // the card itself holds focus on open/slide change; from there, Tab in
        // either direction must land on a dialog control, never behind the modal
        const onButton = active instanceof HTMLElement && focusables.includes(active)
        if (!onButton) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      const buttonFocused =
        event.target instanceof HTMLElement && event.target.closest('button') !== null
      if ((event.key === 'Enter' && !buttonFocused) || event.key === 'ArrowRight') next()
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="onb-overlay" role="dialog" aria-modal="true" aria-label={t(slide.titleKey)}>
      <div className="onb-card" ref={cardRef} tabIndex={-1}>
        {/* all slides stay mounted, stacked in one grid cell: the card locks to
            the tallest slide's height for the language, so the footer and its
            buttons never move between steps. Inactive slides are inert. */}
        <div className="onb-stage">
          {SLIDES.map((s, i) => (
            <div
              className={`onb-slide${i === index ? ' active' : ''}`}
              key={s.titleKey}
              inert={i !== index}
            >
              <SlideArt kind={s.art} />
              <h2 className="onb-title">{t(s.titleKey)}</h2>
              <p className="onb-subtitle">{t(s.subtitleKey)}</p>
              {s.bodyKey && (
                <p className={`onb-body${s.bodyDim ? ' onb-body-dim' : ''}`}>{t(s.bodyKey)}</p>
              )}
              {s.showAccountNote && (
                <div className="onb-account-note">
                  <p>{renderEmphasis(INDEPENDENT_PROJECT_NOTICE[lang])}</p>
                  <p>{renderEmphasis(t('onbAccountNote'))}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="onb-footer">
          <div className="onb-dots">
            {SLIDES.map((s, i) => (
              <button
                key={s.titleKey}
                className={`onb-dot${i === index ? ' active' : ''}`}
                aria-label={t('onbStepAria', { n: i + 1, total: SLIDES.length })}
                aria-current={i === index}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <div className="onb-nav">
            <button className="onb-skip" onClick={onDone}>
              {t('onbSkip')}
            </button>
            {index > 0 && (
              <button className="onb-back" onClick={() => setIndex(index - 1)}>
                {t('onbBack')}
              </button>
            )}
            <button className="onb-next" onClick={next}>
              {isLast ? t('onbStart') : t('onbNext')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
