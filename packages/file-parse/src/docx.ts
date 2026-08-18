import { parseDocx } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import { assertSafeArchive, TextBudget } from './limits'

/** flatten a parsed docx into readable text (structure markers preserved) */
export async function docxToText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  assertSafeArchive(zip, 'docx')
  const doc = await parseDocx(new Uint8Array(bytes))
  const lines: string[] = []
  const budget = new TextBudget()
  const push = (line: string) => {
    budget.add(line, lines.length ? '\n' : '')
    lines.push(line)
  }
  for (const block of doc.blocks) {
    if (block.hidden) continue
    switch (block.type) {
      case 'heading':
        push(`${'#'.repeat(Math.min(block.level ?? 1, 6))} ${runText(block)}`)
        break
      case 'listItem':
        push(`- ${runText(block)}`)
        break
      case 'paragraph':
        push(runText(block))
        break
      case 'table': {
        const rows = block.table?.rows ?? []
        for (const row of rows) {
          push(row.map((cell) => cell.paras.join(' ')).join(' | '))
        }
        break
      }
      default:
        if (block.textboxes?.length) {
          for (const box of block.textboxes) {
            for (const para of box.paras) push(para.runs.map((r) => r.text).join(''))
          }
        } else if (block.previewText) {
          push(block.previewText)
        }
    }
  }
  return lines.join('\n')
}

function runText(block: { runs?: { text: string }[] }): string {
  return (block.runs ?? []).map((r) => r.text).join('')
}
