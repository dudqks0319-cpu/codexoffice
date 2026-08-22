import { describe, expect, it } from 'vitest'

import {
  overlayQaCellEdits,
  qaCellsFromGrid,
  scanWorkbookQa,
  type QAWorkbookInput,
} from '../src/renderer/qa-scanner'

describe('scanWorkbookQa', () => {
  it('converts a live facade range with a non-zero origin', () => {
    expect(
      qaCellsFromGrid(
        [
          [{ v: '#REF!' }, null],
          [{ v: 2, f: '=1+1' }, { v: '' }],
        ],
        2,
        2,
      ),
    ).toEqual({
      C3: { value: '#REF!' },
      C4: { value: 2, formula: '=1+1' },
      D4: { value: '' },
    })
  })

  it('includes unsaved journal values and clears stale formulas before scanning', () => {
    const cells = overlayQaCellEdits({ A1: { value: 2, formula: '=1+1' } }, [
      { row: 0, column: 0, hasValue: true, value: 7 },
      { row: 2, column: 2, hasValue: true, value: '#REF!' },
      { row: 4, column: 4, hasValue: false, value: null },
    ])

    expect(cells.A1).toEqual({ value: 7 })
    expect(cells.C3).toEqual({ value: '#REF!' })
    expect(cells.E5).toBeUndefined()
    expect(
      scanWorkbookQa({ sheets: [{ id: 'sheet-1', name: 'Sheet1', cells }] }).some(
        (finding) => finding.ruleId === 'formula-error' && finding.range === 'C3',
      ),
    ).toBe(true)
  })

  it('detects all eight deterministic QA rule families without executing workbook code', () => {
    const workbook: QAWorkbookInput = {
      sheets: [
        {
          id: 'hidden',
          name: 'Hidden Data',
          hidden: true,
          cells: { A1: { value: 7 } },
        },
        {
          id: 'main',
          name: 'Scenario Plan',
          cells: {
            A1: { value: '#REF!', formula: '=#REF!' },
            B2: { value: 2, formula: '=A2' },
            B4: { value: 4, formula: '=A4' },
            C2: { value: 2, formula: '=A2' },
            C3: { value: 42 },
            C4: { value: 4, formula: '=A4' },
            D1: { value: 99, formula: '=SUM(D2:D3)' },
            D2: { value: 1 },
            D3: { value: 2 },
            E1: { value: 0, formula: "='[Budget.xlsx]Q1'!A1" },
            F1: { value: 7, formula: "='Hidden Data'!A1" },
            Z1: { value: null },
            Z2: { value: null },
          },
          charts: [{ id: 'chart-1', title: 'Empty chart', sourceRefs: ['Z1:Z2'] }],
        },
      ],
    }

    const ruleIds = new Set(scanWorkbookQa(workbook).map((finding) => finding.ruleId))
    expect(ruleIds).toEqual(
      new Set([
        'formula-error',
        'formula-pattern-gap',
        'hardcoded-in-formula-column',
        'total-mismatch',
        'chart-source',
        'external-link',
        'hidden-sheet-dependency',
        'scenario-separation',
      ]),
    )
  })

  it('labels uncertain chart and scenario checks as unverified instead of safe', () => {
    const findings = scanWorkbookQa({
      sheets: [
        {
          id: 'scenario',
          name: 'Scenario',
          cells: {},
          charts: [{ id: 'chart', sourceRefs: ['OFFSET(A1,0,0,2,1)'] }],
        },
      ],
    })
    expect(findings.filter((finding) => finding.status === 'unverified')).toHaveLength(2)
  })

  it('returns no findings for a small, internally consistent workbook', () => {
    expect(
      scanWorkbookQa({
        sheets: [
          {
            id: 'sheet-1',
            name: 'Data',
            cells: {
              A1: { value: 3, formula: '=SUM(A2:A3)' },
              A2: { value: 1 },
              A3: { value: 2 },
            },
          },
        ],
      }),
    ).toEqual([])
  })

  it('does not confuse structured table references with external workbooks', () => {
    const findings = scanWorkbookQa({
      sheets: [
        {
          id: 'sheet-1',
          name: 'Data',
          cells: { B2: { value: 3, formula: '=SUM(Table1[Amount])' } },
        },
      ],
    })
    expect(findings.some((finding) => finding.ruleId === 'external-link')).toBe(false)
  })

  it('does not match a hidden sheet name inside a longer sheet identifier', () => {
    const findings = scanWorkbookQa({
      sheets: [
        { id: 'hidden', name: 'Data', hidden: true, cells: {} },
        {
          id: 'main',
          name: 'Main',
          cells: { A1: { value: 1, formula: '=Metadata!A1' } },
        },
      ],
    })
    expect(findings.some((finding) => finding.ruleId === 'hidden-sheet-dependency')).toBe(false)
  })

  it('does not bridge distant formula regions and bounds huge range work', () => {
    const findings = scanWorkbookQa({
      sheets: [
        {
          id: 'sheet-1',
          name: 'Data',
          cells: {
            B2: { value: 1, formula: '=A2' },
            B50: { value: 'subtotal' },
            B100: { value: 2, formula: '=A100' },
            C1: { value: 3, formula: '=SUM(A1:A60000)' },
          },
          charts: [{ id: 'huge', sourceRefs: ['A1:A60000'] }],
        },
      ],
    })
    expect(
      findings.some(
        (finding) =>
          finding.ruleId === 'hardcoded-in-formula-column' ||
          finding.ruleId === 'formula-pattern-gap',
      ),
    ).toBe(false)
    expect(findings.filter((finding) => finding.status === 'unverified')).toHaveLength(2)
  })
})
