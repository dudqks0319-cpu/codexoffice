/**
 * pptx package management — open the zip, archive the original by SHA-256, and read
 * parts and .rels.
 *
 * Byte fidelity: PackageArchive holds the original bytes of every entry; on save,
 * unmodified entries are written back byte-for-byte (handled by the patch layer).
 * This module only handles reading and metadata.
 */
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { XMLParser } from 'fast-xml-parser'
import type { SlideSize } from './types'
import { asXmlNode, xmlArray } from './xml-utils'

export const PPTX_MAX_INPUT_BYTES = 256 * 1024 * 1024
export const PPTX_MAX_ARCHIVE_ENTRIES = 10_000
export const PPTX_MAX_ARCHIVE_PART_BYTES = 128 * 1024 * 1024
export const PPTX_MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024

type SizedZipEntry = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number }
}

export function assertPptxInputSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('pptx: invalid input file size')
  if (size > PPTX_MAX_INPUT_BYTES) throw new Error('pptx: input file is too large')
}

export function assertPptxArchiveWithinLimits(zip: JSZip): void {
  const entries = Object.entries(zip.files)
  if (entries.length > PPTX_MAX_ARCHIVE_ENTRIES) {
    throw new Error('pptx: archive contains too many entries')
  }

  let expandedBytes = 0
  for (const [name, rawEntry] of entries) {
    const normalized = name.replaceAll('\\', '/')
    if (
      name.includes('\0') ||
      normalized.startsWith('/') ||
      normalized.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw new Error('pptx: archive contains an unsafe path')
    }
    const entry = rawEntry as SizedZipEntry
    if (entry.dir) continue
    const size = entry._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || size === undefined || size < 0) {
      throw new Error('pptx: archive entry size is invalid')
    }
    if (size > PPTX_MAX_ARCHIVE_PART_BYTES) {
      throw new Error('pptx: archive part is too large')
    }
    expandedBytes += size
    if (expandedBytes > PPTX_MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error('pptx: expanded archive is too large')
    }
  }
}

async function readPptxEntry(
  file: JSZip.JSZipObject,
  remainingExpandedBytes: number,
): Promise<Uint8Array> {
  const stream = file.nodeStream('nodebuffer') as Readable
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) {
        stream.destroy()
        reject(error)
      } else {
        const merged = Buffer.concat(chunks, total)
        resolve(new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength))
      }
    }
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      const copy = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += copy.byteLength
      if (total > PPTX_MAX_ARCHIVE_PART_BYTES) {
        finish(new Error('pptx: archive part is too large'))
        return
      }
      if (total > remainingExpandedBytes) {
        finish(new Error('pptx: expanded archive is too large'))
        return
      }
      chunks.push(copy)
    })
    stream.once('end', () => finish())
    stream.once('error', (error: Error) => finish(error))
  })
}

const relsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'Relationship' || name === 'sldId' || name === 'Override',
})

export interface Relationship {
  id: string
  type: string
  target: string
  targetMode?: string
}

export class PackageArchive {
  private constructor(
    private readonly zip: JSZip,
    /** Original bytes of every entry, keyed by path inside the zip */
    readonly entries: Map<string, Uint8Array>,
    readonly originalHash: string,
  ) {}

  static async open(bytes: Uint8Array): Promise<PackageArchive> {
    assertPptxInputSize(bytes.byteLength)
    const originalHash = createHash('sha256').update(bytes).digest('hex')
    const zip = await JSZip.loadAsync(bytes)
    assertPptxArchiveWithinLimits(zip)
    const entries = new Map<string, Uint8Array>()
    const names = Object.keys(zip.files)
    let expandedBytes = 0
    for (const name of names) {
      const file = zip.files[name]
      if (file.dir) continue
      const data = await readPptxEntry(file, PPTX_MAX_ARCHIVE_EXPANDED_BYTES - expandedBytes)
      expandedBytes += data.byteLength
      entries.set(name, data)
    }
    return new PackageArchive(zip, entries, originalHash)
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** Read a part as a UTF-8 string (for XML parts). */
  readText(path: string): string | null {
    const bytes = this.entries.get(path)
    if (!bytes) return null
    return Buffer.from(bytes).toString('utf8')
  }

  readBytes(path: string): Uint8Array | null {
    return this.entries.get(path) ?? null
  }

  /**
   * Read a part's relationships file. partPath e.g. 'ppt/slides/slide1.xml' →
   * 'ppt/slides/_rels/slide1.xml.rels'.
   */
  readRels(partPath: string): Map<string, Relationship> {
    const relsPath = relsPathFor(partPath)
    const rels = new Map<string, Relationship>()
    const xml = this.readText(relsPath)
    if (!xml) return rels
    const doc = asXmlNode(relsParser.parse(xml))
    const list = asXmlNode(doc.Relationships).Relationship
    for (const r of xmlArray(list)) {
      const id = String(r['@_Id'] ?? '')
      rels.set(id, {
        id,
        type: String(r['@_Type'] ?? ''),
        target: String(r['@_Target'] ?? ''),
        ...(r['@_TargetMode'] != null ? { targetMode: String(r['@_TargetMode']) } : {}),
      })
    }
    return rels
  }

  /**
   * Read the presentation's slide size and the slide part paths in order.
   */
  readPresentation(): { size: SlideSize; slidePaths: string[] } {
    const presXml = this.readText('ppt/presentation.xml')
    if (!presXml) throw new Error('pptx: missing ppt/presentation.xml')

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => name === 'p:sldId',
    })
    const pres = asXmlNode(parser.parse(presXml))
    const rootRaw = pres['p:presentation'] ?? pres.presentation
    if (!rootRaw) throw new Error('pptx: malformed presentation.xml')
    const root = asXmlNode(rootRaw)

    // Slide size
    const szRaw = root['p:sldSz'] ?? root.sldSz
    const sz = szRaw ? asXmlNode(szRaw) : null
    const size: SlideSize = {
      cx: sz ? parseInt(String(sz['@_cx']), 10) : 9144000,
      cy: sz ? parseInt(String(sz['@_cy']), 10) : 6858000,
    }

    // Slide order: presentation.xml.rels maps r:id to slide parts
    const rels = this.readRels('ppt/presentation.xml')
    const sldIdLst = asXmlNode(root['p:sldIdLst'] ?? root.sldIdLst)
    const slidePaths: string[] = []
    for (const id of xmlArray(sldIdLst['p:sldId'])) {
      const rId = id['@_r:id'] ?? id['@_id']
      if (!rId) continue
      const rel = rels.get(String(rId))
      if (!rel) continue
      slidePaths.push(resolveTarget('ppt/presentation.xml', rel.target))
    }
    return { size, slidePaths }
  }

  /** Resolve a slide's layout / master part paths (via the rels chain). */
  resolveSlideChain(slidePath: string): {
    layoutPath?: string
    masterPath?: string
    themePath?: string
  } {
    const slideRels = this.readRels(slidePath)
    let layoutPath: string | undefined
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith('/slideLayout')) {
        layoutPath = resolveTarget(slidePath, rel.target)
        break
      }
    }
    let masterPath: string | undefined
    let themePath: string | undefined
    if (layoutPath) {
      const layoutRels = this.readRels(layoutPath)
      for (const rel of layoutRels.values()) {
        if (rel.type.endsWith('/slideMaster')) {
          masterPath = resolveTarget(layoutPath, rel.target)
          break
        }
      }
    }
    if (masterPath) {
      const masterRels = this.readRels(masterPath)
      for (const rel of masterRels.values()) {
        if (rel.type.endsWith('/theme')) {
          themePath = resolveTarget(masterPath, rel.target)
          break
        }
      }
    }
    return { layoutPath, masterPath, themePath }
  }
}

/** 'ppt/slides/slide1.xml' → 'ppt/slides/_rels/slide1.xml.rels' */
export function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf('/')
  const dir = idx >= 0 ? partPath.slice(0, idx) : ''
  const file = idx >= 0 ? partPath.slice(idx + 1) : partPath
  return `${dir ? dir + '/' : ''}_rels/${file}.rels`
}

/**
 * Resolve a relative target into an absolute path inside the zip.
 * basePart is the referencing part's path (its directory is the base); target may be
 * something like '../slideLayouts/slideLayout1.xml'.
 */
export function resolveTarget(basePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const baseDir = basePart.slice(0, basePart.lastIndexOf('/'))
  const parts = baseDir.split('/').filter(Boolean)
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}
