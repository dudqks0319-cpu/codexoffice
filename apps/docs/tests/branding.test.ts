import { describe, expect, it } from 'vitest'
import { strings } from '../src/renderer/i18n/strings'

describe('Codex assistant branding', () => {
  it.each(Object.keys(strings) as Array<keyof typeof strings>)(
    'locale %s labels the assistant Codex',
    (locale) => {
      expect(strings[locale].aiOpenAssistant).toBe('Codex')
      expect(strings[locale].ribbonAiAssistant).toBe('Codex')
    },
  )
})
