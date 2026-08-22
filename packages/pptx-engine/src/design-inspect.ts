import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { basename } from 'node:path'
import type { Readable } from 'node:stream'
import { parseTheme } from './theme'
import { resolveTarget } from './zip'
import { validateThemeSpec, type ThemeSpec } from './theme-apply'
import { asXmlNode, xmlArray } from './xml-utils'

const MAX_ENTRIES = 10_000
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_REL_XML_BYTES = 5 * 1024 * 1024
const MAX_THEME_BYTES = 2 * 1024 * 1024
const SCHEME_KEYS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const

export interface PptxDesignCandidate extends ThemeSpec {
  id: string
  slideCount: number
}

export interface PptxDesignInspection {
  sourceName: string
  defaultCandidateId: string
  candidates: PptxDesignCandidate[]
}

export interface InspectPptxDesignOptions {
  sourceName?: string
  deadlineMs?: number
}

interface Rel {
  type: string
  target: string
  targetMode?: string
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'Relationship' || name === 'p:sldId',
})

function sanitizeText(value: string, fallback: string): string {
  const clean = value
    // eslint-disable-next-line no-control-regex -- package metadata must be safe plain text
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 128)
  return clean || fallback
}

function assertSafePath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('pptx: unsafe ZIP entry path')
}

function relsPath(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`
}

function parseRels(xml: string): Map<string, Rel> {
  const out = new Map<string, Rel>()
  const root = asXmlNode(asXmlNode(parser.parse(xml)).Relationships)
  for (const raw of xmlArray(root.Relationship)) {
    const id = String(raw['@_Id'] ?? '')
    if (!id || out.has(id)) throw new Error('pptx: malformed relationships')
    out.set(id, {
      type: String(raw['@_Type'] ?? ''),
      target: String(raw['@_Target'] ?? ''),
      ...(raw['@_TargetMode'] ? { targetMode: String(raw['@_TargetMode']) } : {}),
    })
  }
  return out
}

function assertNoDuplicateCentralEntries(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const names = new Set<string>()
  let eocd = -1
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65_557);
    offset--
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('pptx: malformed ZIP directory')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('pptx: malformed ZIP directory')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (offset + 46 + nameLength + extraLength + commentLength > bytes.byteLength) {
      throw new Error('pptx: malformed ZIP directory')
    }
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (names.has(name)) throw new Error('pptx: duplicate ZIP entry')
    names.add(name)
    offset += 46 + nameLength + extraLength + commentLength
  }
}

function assertStrictThemeColors(xml: string): void {
  for (const key of SCHEME_KEYS) {
    const match = new RegExp(`<a:${key}\\b[^>]*>([\\s\\S]*?)</a:${key}>`, 'u').exec(xml)
    if (!match) throw new Error(`pptx: missing theme color ${key}`)
    const inner = match[1]!
    const srgb = /<a:srgbClr\b[^>]*\bval=(?:"([^"]*)"|'([^']*)')/u.exec(inner)
    const sys = /<a:sysClr\b[^>]*\blastClr=(?:"([^"]*)"|'([^']*)')/u.exec(inner)
    const value = srgb?.[1] ?? srgb?.[2] ?? sys?.[1] ?? sys?.[2]
    if (!value || !/^[0-9A-Fa-f]{6}$/.test(value)) {
      throw new Error(`pptx: invalid theme color ${key}`)
    }
  }
}

/** Inspect only presentation/relationship/theme parts and return renderer-safe plain data. */
export async function inspectPptxDesign(
  bytes: Uint8Array,
  options: InspectPptxDesignOptions = {},
): Promise<PptxDesignInspection> {
  const deadline = Date.now() + (options.deadlineMs ?? 10_000)
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw new Error('pptx: design inspection timed out')
  }
  assertNoDuplicateCentralEntries(bytes)
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false })
  checkDeadline()
  const files = Object.values(zip.files).filter((file) => !file.dir)
  if (files.length > MAX_ENTRIES) throw new Error('pptx: too many ZIP entries')
  if (files.some((file) => /^ppt\/theme\/themeOverride\d+\.xml$/iu.test(file.name))) {
    throw new Error('pptx: theme overrides are not supported for design import')
  }
  let expanded = 0
  const seen = new Set<string>()
  for (const file of files) {
    const unsafe = (file as typeof file & { unsafeOriginalName?: string }).unsafeOriginalName
    assertSafePath(unsafe ?? file.name)
    assertSafePath(file.name)
    if (seen.has(file.name)) throw new Error('pptx: duplicate ZIP entry')
    seen.add(file.name)
    const declared = Number(
      (file as typeof file & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
        0,
    )
    if (!Number.isSafeInteger(declared) || declared < 0) throw new Error('pptx: invalid ZIP size')
    expanded += declared
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('pptx: expanded ZIP is too large')
  }

  let inspectedXmlBytes = 0
  const readXml = async (path: string, limit: number): Promise<string> => {
    checkDeadline()
    assertSafePath(path)
    const file = zip.file(path)
    if (!file) throw new Error(`pptx: missing ${path}`)
    const declared = Number(
      (file as typeof file & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ??
        0,
    )
    if (declared > limit) throw new Error(`pptx: XML part is too large: ${path}`)
    const remaining = MAX_EXPANDED_BYTES - inspectedXmlBytes
    if (remaining <= 0) throw new Error('pptx: expanded ZIP is too large')
    const stream = file.nodeStream('nodebuffer') as Readable
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          stream.destroy()
          reject(error)
        } else {
          resolve(Buffer.concat(chunks, total))
        }
      }
      const timer = setTimeout(
        () => finish(new Error('pptx: design inspection timed out')),
        Math.max(1, deadline - Date.now()),
      )
      stream.on('data', (chunk: Buffer | Uint8Array) => {
        if (Date.now() >= deadline) {
          finish(new Error('pptx: design inspection timed out'))
          return
        }
        const copy = Buffer.from(chunk)
        total += copy.byteLength
        if (total > limit || total > remaining) {
          finish(
            new Error(
              total > remaining ? 'pptx: expanded ZIP is too large' : 'pptx: XML part is too large',
            ),
          )
          return
        }
        chunks.push(copy)
      })
      stream.once('error', (error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      )
      stream.once('end', () => finish())
    })
    inspectedXmlBytes += bytes.byteLength
    checkDeadline()
    return bytes.toString('utf8')
  }
  const relsCache = new Map<string, Promise<Map<string, Rel>>>()
  const readRels = (partPath: string): Promise<Map<string, Rel>> => {
    const path = relsPath(partPath)
    const existing = relsCache.get(path)
    if (existing) return existing
    const pending = readXml(path, MAX_REL_XML_BYTES).then(parseRels)
    relsCache.set(path, pending)
    return pending
  }
  const internalTarget = (partPath: string, rel: Rel, kind: string): string => {
    if (rel.targetMode?.toLowerCase() === 'external') {
      throw new Error(`pptx: external ${kind} relationship is not allowed`)
    }
    const target = resolveTarget(partPath, rel.target)
    assertSafePath(target)
    return target
  }

  const presentationPath = 'ppt/presentation.xml'
  const presentationXml = await readXml(presentationPath, MAX_REL_XML_BYTES)
  const presentation = asXmlNode(parser.parse(presentationXml))
  const root = asXmlNode(presentation['p:presentation'] ?? presentation.presentation)
  const slideIds = xmlArray(asXmlNode(root['p:sldIdLst'] ?? root.sldIdLst)['p:sldId'])
  if (!slideIds.length) throw new Error('pptx: presentation has no slides')
  const presentationRels = await readRels(presentationPath)
  const themeUse = new Map<string, number>()
  const themeOrder: string[] = []
  for (const slideId of slideIds) {
    const slideRel = presentationRels.get(String(slideId['@_r:id'] ?? ''))
    if (!slideRel || !slideRel.type.endsWith('/slide'))
      throw new Error('pptx: invalid slide relationship')
    const slidePath = internalTarget(presentationPath, slideRel, 'slide')
    const layoutRel = [...(await readRels(slidePath)).values()].find((rel) =>
      rel.type.endsWith('/slideLayout'),
    )
    if (!layoutRel) throw new Error('pptx: slide has no layout')
    const layoutPath = internalTarget(slidePath, layoutRel, 'layout')
    const masterRel = [...(await readRels(layoutPath)).values()].find((rel) =>
      rel.type.endsWith('/slideMaster'),
    )
    if (!masterRel) throw new Error('pptx: layout has no master')
    const masterPath = internalTarget(layoutPath, masterRel, 'master')
    const themeRel = [...(await readRels(masterPath)).values()].find((rel) =>
      rel.type.endsWith('/theme'),
    )
    if (!themeRel) throw new Error('pptx: master has no theme')
    const themePath = internalTarget(masterPath, themeRel, 'theme')
    if (!/^ppt\/theme\/theme\d+\.xml$/u.test(themePath)) throw new Error('pptx: invalid theme path')
    if (!themeUse.has(themePath)) themeOrder.push(themePath)
    themeUse.set(themePath, (themeUse.get(themePath) ?? 0) + 1)
  }

  const candidates: PptxDesignCandidate[] = []
  for (const [index, themePath] of themeOrder.entries()) {
    const xml = await readXml(themePath, MAX_THEME_BYTES)
    assertStrictThemeColors(xml)
    const parsed = parseTheme(xml)
    const nameMatch = /<a:(?:theme|clrScheme)\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')/u.exec(xml)
    const spec: ThemeSpec = {
      name: sanitizeText(nameMatch?.[1] ?? nameMatch?.[2] ?? '', `Theme ${index + 1}`),
      colors: Object.fromEntries(SCHEME_KEYS.map((key) => [key, parsed.colors[key]])),
      ...(parsed.majorFont ? { majorFont: sanitizeText(parsed.majorFont, 'Default') } : {}),
      ...(parsed.minorFont ? { minorFont: sanitizeText(parsed.minorFont, 'Default') } : {}),
      ...(parsed.majorEaFont ? { majorEaFont: sanitizeText(parsed.majorEaFont, 'Default') } : {}),
      ...(parsed.minorEaFont ? { minorEaFont: sanitizeText(parsed.minorEaFont, 'Default') } : {}),
      ...(parsed.majorCsFont ? { majorCsFont: sanitizeText(parsed.majorCsFont, 'Default') } : {}),
      ...(parsed.minorCsFont ? { minorCsFont: sanitizeText(parsed.minorCsFont, 'Default') } : {}),
    }
    validateThemeSpec(spec)
    candidates.push({ id: `theme-${index + 1}`, slideCount: themeUse.get(themePath) ?? 0, ...spec })
  }
  if (!candidates.length) throw new Error('pptx: no complete themes found')
  return {
    sourceName: sanitizeText(
      basename(options.sourceName ?? 'presentation.pptx'),
      'presentation.pptx',
    ),
    defaultCandidateId: candidates[0]!.id,
    candidates,
  }
}
