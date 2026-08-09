import { columnLabel, parseRange } from '../domain/cell-address'

export type QAFindingSeverity = 'critical' | 'warning' | 'info'
export type QAFindingStatus = 'issue' | 'unverified'

export interface QACellInput {
  readonly value: string | number | boolean | null
  readonly formula?: string | undefined
}

export interface QACellEditInput {
  readonly row: number
  readonly column: number
  readonly hasValue: boolean
  readonly value: string | number | boolean | null
  readonly formula?: string | undefined
}

function qaInputValue(value: unknown): QACellInput['value'] {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : null
}

/** Convert a live Univer facade range to deterministic A1-keyed QA cells. */
export function qaCellsFromGrid(
  grid: readonly (readonly unknown[])[],
  startRow = 0,
  startColumn = 0,
): Record<string, QACellInput> {
  const cells: Record<string, QACellInput> = {}
  grid.forEach((rawRow, rowOffset) => {
    rawRow.forEach((rawCell, columnOffset) => {
      if (!rawCell || typeof rawCell !== 'object') return
      const cell = rawCell as { v?: unknown; f?: unknown }
      const formula = typeof cell.f === 'string' ? cell.f : undefined
      const value = qaInputValue(cell.v)
      if (formula === undefined && value === null) return
      const address = `${columnLabel(startColumn + columnOffset)}${startRow + rowOffset + 1}`
      cells[address] = { value, ...(formula === undefined ? {} : { formula }) }
    })
  })
  return cells
}

export interface QAChartInput {
  readonly id: string
  readonly title?: string | undefined
  readonly sourceRefs: readonly string[]
}

export interface QASheetInput {
  readonly id: string
  readonly name: string
  readonly hidden?: boolean | undefined
  readonly cells: Readonly<Record<string, QACellInput>>
  readonly charts?: readonly QAChartInput[] | undefined
}

export interface QAWorkbookInput {
  readonly sheets: readonly QASheetInput[]
  readonly definedNames?: readonly { readonly name: string; readonly formula: string }[] | undefined
}

export interface QAFinding {
  readonly ruleId:
    | 'formula-error'
    | 'formula-pattern-gap'
    | 'hardcoded-in-formula-column'
    | 'total-mismatch'
    | 'chart-source'
    | 'external-link'
    | 'hidden-sheet-dependency'
    | 'scenario-separation'
    | 'workbook-coverage'
  readonly severity: QAFindingSeverity
  readonly status: QAFindingStatus
  readonly sheetId?: string | undefined
  readonly sheetName?: string | undefined
  readonly range?: string | undefined
  readonly evidence: string
  readonly remediation: string
}

const ERROR_VALUE = /^#(?:REF!|VALUE!|DIV\/0!|NAME\?|N\/A|NUM!|NULL!)$/i
const EXTERNAL_REFERENCE = /\[[^\]]+\.(?:xlsx|xlsm|xlsb|xls|csv)\]|https?:\/\//i
const CELL_ADDRESS = /^([A-Z]+)([1-9]\d*)$/
const MAX_QA_RANGE_CELLS = 50_000
const MAX_QA_WORKBOOK_RANGE_CELLS = 200_000

/** Overlay unsaved workbook edits so QA inspects what the user can currently see. */
export function overlayQaCellEdits(
  source: Readonly<Record<string, QACellInput>>,
  edits: Iterable<QACellEditInput>,
): Record<string, QACellInput> {
  const cells = { ...source }
  for (const edit of edits) {
    if (!edit.hasValue || edit.row < 0 || edit.column < 0) continue
    const address = `${columnLabel(edit.column)}${edit.row + 1}`
    cells[address] = {
      value: edit.value,
      ...(edit.formula === undefined ? {} : { formula: edit.formula }),
    }
  }
  return cells
}

function addressParts(address: string): { column: string; row: number } | null {
  const match = CELL_ADDRESS.exec(address.toUpperCase())
  return match ? { column: match[1]!, row: Number(match[2]) } : null
}

function nonEmpty(cell: QACellInput | undefined): boolean {
  return !!cell && (cell.formula !== undefined || (cell.value !== null && cell.value !== ''))
}

function formulaColumns(sheet: QASheetInput): Map<string, Array<{ row: number; formula: string }>> {
  const result = new Map<string, Array<{ row: number; formula: string }>>()
  for (const [address, cell] of Object.entries(sheet.cells)) {
    if (!cell.formula) continue
    const parsed = addressParts(address)
    if (!parsed) continue
    const rows = result.get(parsed.column) ?? []
    rows.push({ row: parsed.row, formula: cell.formula })
    result.set(parsed.column, rows)
  }
  return result
}

function parseSimpleSum(
  formula: string,
): { sheetName?: string | undefined; start: string; end: string } | null {
  const match =
    /^=SUM\((?:(?:'([^']+)'|([^'!]+))!)?\$?([A-Z]+)\$?([1-9]\d*):\$?([A-Z]+)\$?([1-9]\d*)\)$/i.exec(
      formula.trim(),
    )
  if (!match) return null
  return {
    ...(match[1] || match[2] ? { sheetName: (match[1] || match[2])!.trim() } : {}),
    start: `${match[3]!.toUpperCase()}${match[4]}`,
    end: `${match[5]!.toUpperCase()}${match[6]}`,
  }
}

function rangeAddresses(
  start: string,
  end: string,
  budget?: { remaining: number },
): string[] | null {
  const parsed = parseRange(`${start}:${end}`)
  const cellCount =
    (parsed.endRow - parsed.startRow + 1) * (parsed.endColumn - parsed.startColumn + 1)
  if (cellCount > MAX_QA_RANGE_CELLS || (budget && cellCount > budget.remaining)) return null
  if (budget) budget.remaining -= cellCount
  const result: string[] = []
  for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
    for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
      result.push(`${columnLabel(column)}${row + 1}`)
    }
  }
  return result
}

function columnNumber(label: string): number {
  let value = 0
  for (const char of label) value = value * 26 + char.charCodeAt(0) - 64
  return value
}

/** Lightweight R1C1-style normalization for ordinary A1 references. */
function normalizedFormulaPattern(formula: string, address: string): string {
  const origin = addressParts(address)
  if (!origin) return formula.toUpperCase()
  const originColumn = columnNumber(origin.column)
  return formula
    .toUpperCase()
    .replace(/(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/g, (_, colAbs, col, rowAbs, row) => {
      const column = columnNumber(col)
      const rowNumber = Number(row)
      const normalizedColumn = colAbs ? `C${column}` : `C[${column - originColumn}]`
      const normalizedRow = rowAbs ? `R${rowNumber}` : `R[${rowNumber - origin.row}]`
      return `${normalizedRow}${normalizedColumn}`
    })
}

function normalizeChartRef(ref: string): {
  sheetName?: string | undefined
  range?: string | undefined
  broken: boolean
} {
  if (ref.includes('#REF!')) return { broken: true }
  const cleaned = ref.replace(/\$/g, '').trim()
  const bang = cleaned.lastIndexOf('!')
  const rawRange = bang >= 0 ? cleaned.slice(bang + 1) : cleaned
  const sheetName = bang >= 0 ? cleaned.slice(0, bang).replace(/^'|'$/g, '') : undefined
  try {
    parseRange(rawRange)
    return { ...(sheetName ? { sheetName } : {}), range: rawRange, broken: false }
  } catch {
    return { ...(sheetName ? { sheetName } : {}), broken: false }
  }
}

export function scanWorkbookQa(workbook: QAWorkbookInput): QAFinding[] {
  const findings: QAFinding[] = []
  const rangeBudget = { remaining: MAX_QA_WORKBOOK_RANGE_CELLS }
  const sheetsByName = new Map(workbook.sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]))
  const hiddenNames = workbook.sheets.filter((sheet) => sheet.hidden).map((sheet) => sheet.name)

  for (const sheet of workbook.sheets) {
    for (const [address, cell] of Object.entries(sheet.cells)) {
      if (
        (typeof cell.value === 'string' && ERROR_VALUE.test(cell.value.trim())) ||
        cell.formula?.includes('#REF!')
      ) {
        findings.push({
          ruleId: 'formula-error',
          severity: 'critical',
          status: 'issue',
          sheetId: sheet.id,
          sheetName: sheet.name,
          range: address,
          evidence: `${address}: ${cell.value ?? cell.formula}`,
          remediation: 'Repair the broken reference or formula before using this result.',
        })
      }

      if (cell.formula && EXTERNAL_REFERENCE.test(cell.formula)) {
        findings.push({
          ruleId: 'external-link',
          severity: 'warning',
          status: 'issue',
          sheetId: sheet.id,
          sheetName: sheet.name,
          range: address,
          evidence: `${address} contains an external reference.`,
          remediation: 'Verify and explicitly approve the external workbook or URL reference.',
        })
      }

      for (const hiddenName of hiddenNames) {
        const escaped = hiddenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (
          cell.formula &&
          new RegExp(`(?:^|[^A-Z0-9_.])(?:'${escaped}'|${escaped})!`, 'i').test(cell.formula)
        ) {
          findings.push({
            ruleId: 'hidden-sheet-dependency',
            severity: 'warning',
            status: 'issue',
            sheetId: sheet.id,
            sheetName: sheet.name,
            range: address,
            evidence: `${address} depends on hidden sheet ${hiddenName}.`,
            remediation:
              'Review the hidden precedent sheet and document why the dependency is safe.',
          })
        }
      }

      if (typeof cell.value === 'number' && cell.formula) {
        const sum = parseSimpleSum(cell.formula)
        if (sum) {
          const sourceSheet = sum.sheetName ? sheetsByName.get(sum.sheetName.toLowerCase()) : sheet
          if (sourceSheet) {
            const addresses = rangeAddresses(sum.start, sum.end, rangeBudget)
            if (!addresses) {
              findings.push({
                ruleId: 'total-mismatch',
                severity: 'info',
                status: 'unverified',
                sheetId: sheet.id,
                sheetName: sheet.name,
                range: address,
                evidence: `${address} uses a SUM range above the ${MAX_QA_RANGE_CELLS.toLocaleString()}-cell QA limit.`,
                remediation: 'Review or recalculate this total with a bounded source range.',
              })
              continue
            }
            const values = addresses.map((sourceAddress) => sourceSheet.cells[sourceAddress]?.value)
            if (values.length > 0 && values.every((value) => typeof value === 'number')) {
              const expected = (values as number[]).reduce((total, value) => total + value, 0)
              if (Math.abs(expected - cell.value) > Math.max(1e-9, Math.abs(expected) * 1e-9)) {
                findings.push({
                  ruleId: 'total-mismatch',
                  severity: 'critical',
                  status: 'issue',
                  sheetId: sheet.id,
                  sheetName: sheet.name,
                  range: address,
                  evidence: `${address} caches ${cell.value}, but ${cell.formula} sums to ${expected}.`,
                  remediation: 'Recalculate the workbook and verify the total before export.',
                })
              }
            }
          }
        }
      }
    }

    for (const [column, entries] of formulaColumns(sheet)) {
      const sorted = [...entries].sort((a, b) => a.row - b.row)
      for (let index = 0; index < sorted.length - 1; index += 1) {
        const before = sorted[index]!
        const after = sorted[index + 1]!
        // Only a single missing row between matching relative formulas is a
        // strong deterministic signal. Wider gaps commonly separate tables,
        // subtotals, and independent sections.
        if (after.row - before.row !== 2) continue
        if (
          normalizedFormulaPattern(before.formula, `${column}${before.row}`) !==
          normalizedFormulaPattern(after.formula, `${column}${after.row}`)
        ) {
          continue
        }
        const row = before.row + 1
        const address = `${column}${row}`
        const cell = sheet.cells[address]
        findings.push({
          ruleId: nonEmpty(cell) ? 'hardcoded-in-formula-column' : 'formula-pattern-gap',
          severity: 'warning',
          status: 'issue',
          sheetId: sheet.id,
          sheetName: sheet.name,
          range: address,
          evidence: nonEmpty(cell)
            ? `${address} is hardcoded between matching neighboring formula patterns.`
            : `${address} is blank between matching neighboring formula patterns.`,
          remediation: nonEmpty(cell)
            ? 'Confirm the override or replace it through a reviewed formula change.'
            : 'Check whether the missing formula should be filled down.',
        })
      }
    }

    for (const chart of sheet.charts ?? []) {
      for (const ref of chart.sourceRefs) {
        const parsed = normalizeChartRef(ref)
        const sourceSheet = parsed.sheetName
          ? sheetsByName.get(parsed.sheetName.toLowerCase())
          : sheet
        let evidence: string | null = null
        let status: QAFindingStatus = 'issue'
        if (parsed.broken) evidence = `Chart ${chart.title ?? chart.id} contains #REF!.`
        else if (!sourceSheet || !parsed.range) {
          evidence = `Chart ${chart.title ?? chart.id} has an unsupported or missing source: ${ref}.`
          status = 'unverified'
        } else {
          const bounds = parseRange(parsed.range)
          const start = `${columnLabel(bounds.startColumn)}${bounds.startRow + 1}`
          const end = `${columnLabel(bounds.endColumn)}${bounds.endRow + 1}`
          const addresses = rangeAddresses(start, end, rangeBudget)
          if (!addresses) {
            evidence = `Chart ${chart.title ?? chart.id} source exceeds the ${MAX_QA_RANGE_CELLS.toLocaleString()}-cell QA limit: ${ref}.`
            status = 'unverified'
          } else if (addresses.every((address) => !nonEmpty(sourceSheet.cells[address]))) {
            evidence = `Chart ${chart.title ?? chart.id} points to an empty range ${ref}.`
          }
        }
        if (evidence) {
          findings.push({
            ruleId: 'chart-source',
            severity: status === 'issue' ? 'warning' : 'info',
            status,
            sheetId: sheet.id,
            sheetName: sheet.name,
            evidence,
            remediation: 'Reconnect the chart to a verified non-empty worksheet range.',
          })
        }
      }
    }

    const scenarioSignal =
      /scenario|시나리오|シナリオ|情景/i.test(sheet.name) ||
      Object.values(sheet.cells).some(
        (cell) => typeof cell.value === 'string' && /scenario|시나리오/i.test(cell.value),
      )
    if (scenarioSignal) {
      const labels = Object.values(sheet.cells)
        .map((cell) => (typeof cell.value === 'string' ? cell.value.toLowerCase() : ''))
        .filter(Boolean)
      const hasInput = labels.some((value) => /input|assumption|입력|가정/.test(value))
      const hasOutput = labels.some((value) => /output|result|결과|산출/.test(value))
      if (!hasInput || !hasOutput) {
        findings.push({
          ruleId: 'scenario-separation',
          severity: 'info',
          status: 'unverified',
          sheetId: sheet.id,
          sheetName: sheet.name,
          evidence:
            'Scenario inputs and outputs are not clearly labelled for deterministic verification.',
          remediation:
            'Label input/assumption cells and output/result cells before relying on scenarios.',
        })
      }
    }
  }

  for (const defined of workbook.definedNames ?? []) {
    if (!EXTERNAL_REFERENCE.test(defined.formula)) continue
    findings.push({
      ruleId: 'external-link',
      severity: 'warning',
      status: 'issue',
      evidence: `Defined name ${defined.name} contains an external reference.`,
      remediation: 'Verify or remove the external defined-name reference.',
    })
  }

  return findings
}
