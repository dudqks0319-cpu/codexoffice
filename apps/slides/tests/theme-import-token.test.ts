import { describe, expect, it } from 'vitest'
import { ThemeImportTokenStore } from '../src/main/theme-import-token'

describe('theme import preview tokens', () => {
  it('are renderer/session-bound and single-use', () => {
    const store = new ThemeImportTokenStore<object, string>()
    const session = {}
    const pending = store.create(7, session, ['theme'])
    expect(store.consume(8, pending.token, session)).toBeNull()
    const fresh = store.create(7, session, ['theme'])
    expect(store.consume(7, fresh.token, {})).toBeNull()
    const usable = store.create(7, session, ['theme'])
    expect(store.consume(7, usable.token, session)?.candidates).toEqual(['theme'])
    expect(store.consume(7, usable.token, session)).toBeNull()
  })

  it('expires after five minutes and replacement invalidates the old token', () => {
    let now = 1_000
    const store = new ThemeImportTokenStore<object, string>(300_000, () => now)
    const session = {}
    const old = store.create(1, session, ['old'])
    const replacement = store.create(1, session, ['new'])
    expect(store.consume(1, old.token, session)).toBeNull()
    const expiring = store.create(1, session, ['new'])
    now += 300_000
    expect(store.consume(1, expiring.token, session)).toBeNull()
    expect(replacement.token).not.toBe(old.token)
  })
})
