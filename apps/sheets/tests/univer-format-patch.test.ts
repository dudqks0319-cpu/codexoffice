import { describe, expect, it, vi } from 'vitest'

import { HorizontalAlign } from '@univerjs/core'
import { applyFormatPatchToRange } from '../src/renderer/univer-sync'

function fakeRange() {
  return {
    setValue: vi.fn(),
  }
}

describe('applyFormatPatchToRange horizontal alignment', () => {
  it('writes right alignment through the complete Univer style enum', () => {
    const range = fakeRange()

    applyFormatPatchToRange(range as never, { horizontalAlign: 'right' })

    expect(range.setValue).toHaveBeenCalledWith({ s: { ht: HorizontalAlign.RIGHT } })
  })

  it('clears horizontal alignment with a null style value', () => {
    const range = fakeRange()

    applyFormatPatchToRange(range as never, { horizontalAlign: null })

    expect(range.setValue).toHaveBeenCalledWith({ s: { ht: null } })
  })
})
