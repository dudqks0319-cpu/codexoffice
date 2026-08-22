import { describe, expect, it } from 'vitest'

import { lookupPdfProcessIdentity } from '../src/main/pdf-process-identity'

describe('PDF process generation identity', () => {
  it('returns a stable identity for the current process', () => {
    const first = lookupPdfProcessIdentity(process.pid)
    const second = lookupPdfProcessIdentity(process.pid)

    expect(first.state).toBe('alive')
    expect(second).toEqual(first)
    if (first.state === 'alive') {
      expect(first.identity).toMatch(/^(darwin|linux|win32):/)
    }
  })

  it('classifies invalid PIDs as dead without an OS query', () => {
    expect(lookupPdfProcessIdentity(0)).toEqual({ state: 'dead' })
    expect(lookupPdfProcessIdentity(-1)).toEqual({ state: 'dead' })
    expect(lookupPdfProcessIdentity(Number.NaN)).toEqual({ state: 'dead' })
  })
})
