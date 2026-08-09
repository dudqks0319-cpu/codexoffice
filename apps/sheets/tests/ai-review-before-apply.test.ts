import { describe, expect, it, vi } from 'vitest'

import { InMemoryWorkbookAdapter } from '../src/domain/in-memory-workbook'
import { proposeOperations, type PlanContext } from '../src/renderer/plan-operations'

describe('AI review-before-apply contract', () => {
  it('creates a preview without changing the workbook', () => {
    const adapter = new InMemoryWorkbookAdapter({
      revision: 0,
      sheets: [{ id: 'sheet-1', name: 'Sheet1', cells: { A1: { value: 'before' } } }],
    })
    const setPreview = vi.fn()
    const context: PlanContext = {
      adapterRef: { current: adapter },
      univerRef: { current: null },
      lazyWorkbookRef: { current: null },
      lazyPreviewRef: { current: null },
      setPreview,
    }

    const result = proposeOperations(
      context,
      [{ op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 'after' }],
      'Update A1',
    )

    expect(result.ok).toBe(true)
    expect(adapter.getSnapshot().revision).toBe(0)
    expect(adapter.getSnapshot().sheets[0]?.cells.A1?.value).toBe('before')
    expect(setPreview).toHaveBeenCalledTimes(1)
  })
})
