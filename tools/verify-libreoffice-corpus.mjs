import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const root = resolve(import.meta.dirname, '..')
const corpus = [
  {
    kind: 'docx',
    path: 'apps/docs/tests/pagination-corpus/docx/06-with-footnotes.docx',
  },
  {
    kind: 'xlsx',
    path: 'qa-artifacts/model-comparison/luna-max/luna-max-portfolio.xlsx',
  },
  { kind: 'pptx', path: 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx' },
]

function count(text, expression) {
  return [...text.matchAll(expression)].length
}

async function metrics(kind, bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  const text = async (path) => {
    const entry = zip.file(path)
    if (!entry) throw new Error(`${kind}: required OOXML part missing: ${path}`)
    return entry.async('string')
  }
  if (kind === 'docx') {
    const document = await text('word/document.xml')
    const footnotes = await text('word/footnotes.xml')
    return {
      parts: names.length,
      bodyFootnoteReferences: count(document, /<w:footnoteReference\b/g),
      footnotes: count(footnotes, /<w:footnote\b/g),
      media: names.filter((name) => name.startsWith('word/media/')).length,
    }
  }
  if (kind === 'xlsx') {
    const workbook = await text('xl/workbook.xml')
    return {
      parts: names.length,
      sheets: count(workbook, /<(?:[A-Za-z0-9_]+:)?sheet\b/g),
      worksheets: names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length,
      charts: names.filter((name) => /(?:^|\/)charts\/chart\d+\.xml$/.test(name)).length,
      media: names.filter((name) => name.startsWith('xl/media/')).length,
    }
  }
  const presentation = await text('ppt/presentation.xml')
  return {
    parts: names.length,
    slideIds: count(presentation, /<p:sldId\b/g),
    slides: names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
    masters: names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length,
    media: names.filter((name) => name.startsWith('ppt/media/')).length,
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'genoffice-lo-corpus-'))
const profile = join(scratch, 'profile')
const reports = []
try {
  for (const entry of corpus) {
    const source = resolve(root, entry.path)
    const outputDir = join(scratch, entry.kind)
    mkdirSync(outputDir, { recursive: true })
    execFileSync(
      'soffice',
      [
        '--headless',
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--convert-to',
        entry.kind,
        '--outdir',
        outputDir,
        source,
      ],
      { timeout: 120_000, stdio: 'pipe' },
    )
    const output = join(outputDir, `${basename(source, extname(source))}.${entry.kind}`)
    const before = await metrics(entry.kind, readFileSync(source))
    const after = await metrics(entry.kind, readFileSync(output))
    const stableKeys = Object.keys(before).filter((key) => key !== 'parts')
    const changed = stableKeys.filter((key) => before[key] !== after[key])
    if (changed.length > 0) {
      throw new Error(
        `${entry.path}: LibreOffice round-trip changed structural counts: ${changed.join(', ')} ` +
          `(before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`,
      )
    }
    reports.push({ fixture: entry.path, kind: entry.kind, before, after, passed: true })
  }
  process.stdout.write(`${JSON.stringify({ passed: true, reports }, null, 2)}\n`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
