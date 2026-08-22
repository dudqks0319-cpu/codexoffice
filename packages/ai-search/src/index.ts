/**
 * Search utilities (main process) — Serper Google API with DuckDuckGo as the
 * no-key and downstream-failure fallback. Runs in the main process (Node fetch)
 * to avoid renderer CORS; the Serper key reuses SERPER_API_KEY.
 */

import {
  COPYRIGHT_HOSTS,
  asRecord,
  safeHost,
  type ImageSearchResult,
  type WebSearchResult,
} from './shared'
export type { ImageSearchResult, WebSearchResult } from './shared'

const SERPER_KEY = () => process.env.SERPER_API_KEY ?? ''
const MAX_QUERY_CHARS = 512
const MAX_RESULTS = 10
const MAX_SEARCH_BODY_BYTES = 2 * 1024 * 1024
const SEARCH_TIMEOUT_MS = 15_000

export function createSearchRequestGate(
  options: {
    now?: () => number
    disabled?: () => boolean
    maxConcurrent?: number
    maxBurst?: number
    maxDaily?: number
  } = {},
) {
  let active = 0
  const events: number[] = []
  return {
    acquire(): () => void {
      if ((options.disabled ?? (() => process.env.GENOFFICE_SEARCH_DISABLED === '1'))())
        throw new Error('Search unavailable')
      const now = (options.now ?? Date.now)()
      while (events[0] !== undefined && events[0] <= now - 24 * 60 * 60_000) events.shift()
      if (active >= (options.maxConcurrent ?? 3)) throw new Error('Search unavailable')
      if (events.filter((at) => at > now - 60_000).length >= (options.maxBurst ?? 30))
        throw new Error('Search unavailable')
      if (events.length >= (options.maxDaily ?? 200)) throw new Error('Search unavailable')
      active++
      events.push(now)
      let released = false
      return () => {
        if (released) return
        released = true
        active--
      }
    },
  }
}

const searchGate = createSearchRequestGate()

function searchInput(query: unknown, maxResults: unknown): { query: string; maxResults: number } {
  if (typeof query !== 'string') throw new Error('Invalid search request')
  const normalized = query.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > MAX_QUERY_CHARS) throw new Error('Invalid search request')
  if (
    !Number.isInteger(maxResults) ||
    (maxResults as number) < 1 ||
    (maxResults as number) > MAX_RESULTS
  )
    throw new Error('Invalid search request')
  return { query: normalized, maxResults: maxResults as number }
}

// ── Web search ──────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  maxResults = 6,
): Promise<{
  results: WebSearchResult[]
  answer?: string
  method: string
}> {
  ;({ query, maxResults } = searchInput(query, maxResults))
  const release = searchGate.acquire()
  try {
    const key = SERPER_KEY()
    if (key) {
      try {
        const { response: resp, text } = await fetchTextBounded(
          'https://google.serper.dev/search',
          {
            method: 'POST',
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: maxResults, gl: 'us', hl: 'en' }),
          },
        )
        if (resp.ok) {
          const data = asRecord(JSON.parse(text))
          const organic: unknown[] = Array.isArray(data.organic) ? data.organic : []
          const results: WebSearchResult[] = organic.slice(0, maxResults).map((item) => {
            const o = asRecord(item)
            return {
              title: String(o.title ?? ''),
              url: String(o.link ?? ''),
              snippet: String(o.snippet ?? ''),
            }
          })
          const answerBox = asRecord(data.answerBox)
          const answerRaw =
            answerBox.answer || answerBox.snippet || asRecord(data.knowledgeGraph).description
          const answer = typeof answerRaw === 'string' && answerRaw ? answerRaw : undefined
          if (results.length) {
            return answer !== undefined
              ? { results, answer, method: 'serper' }
              : { results, method: 'serper' }
          }
        }
      } catch {
        /* fall back to DuckDuckGo */
      }
    }
    return { ...(await duckWebSearch(query, maxResults)), method: 'duckduckgo' }
  } finally {
    release()
  }
}

// ── Image search ────────────────────────────────────────────────────

export async function imageSearch(
  query: string,
  maxResults = 8,
): Promise<{
  images: ImageSearchResult[]
  method: string
}> {
  ;({ query, maxResults } = searchInput(query, maxResults))
  const release = searchGate.acquire()
  try {
    const key = SERPER_KEY()
    if (key) {
      try {
        const { response: resp, text } = await fetchTextBounded(
          'https://google.serper.dev/images',
          {
            method: 'POST',
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: query, num: Math.min(maxResults, 10), gl: 'us', hl: 'en' }),
          },
        )
        if (resp.ok) {
          const data = asRecord(JSON.parse(text))
          const raw: unknown[] = Array.isArray(data.images) ? data.images : []
          const images: ImageSearchResult[] = []
          for (const item of raw) {
            const img = asRecord(item)
            const imageUrl = String(img.imageUrl ?? img.original ?? '')
            if (!imageUrl) continue
            if (COPYRIGHT_HOSTS.some((d) => imageUrl.toLowerCase().includes(d))) continue
            const entry: ImageSearchResult = {
              title: String(img.title ?? ''),
              imageUrl,
              sourceUrl: String(img.link ?? ''),
              source: String(img.source ?? safeHost(img.link)),
            }
            if (typeof img.imageWidth === 'number') entry.width = img.imageWidth
            if (typeof img.imageHeight === 'number') entry.height = img.imageHeight
            images.push(entry)
            if (images.length >= maxResults) break
          }
          if (images.length) return { images, method: 'serper' }
        }
      } catch {
        /* fall back to DuckDuckGo */
      }
    }
    return { images: await duckImageSearch(query, maxResults), method: 'duckduckgo' }
  } finally {
    release()
  }
}

// ── DuckDuckGo fallback (no key / quota exhausted) ──────────────────

async function duckWebSearch(
  query: string,
  maxResults: number,
): Promise<{ results: WebSearchResult[] }> {
  try {
    // DuckDuckGo HTML endpoint (lightweight, no key needed)
    const { response: resp, text: html } = await fetchTextBounded(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    )
    if (!resp.ok) return { results: [] }
    const results: WebSearchResult[] = []
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const url = decodeDuckUrl(m[1]!)
      const title = stripTags(m[2]!)
      if (url && title) results.push({ title, url, snippet: '' })
    }
    return { results }
  } catch {
    return { results: [] }
  }
}

async function duckImageSearch(query: string, maxResults: number): Promise<ImageSearchResult[]> {
  try {
    // DuckDuckGo i.js needs a vqd token, so it takes two steps
    const { response: tokenResp, text: tokenHtml } = await fetchTextBounded(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    )
    if (!tokenResp.ok) return []
    const vqd = /vqd=["']?([\d-]+)["']?/.exec(tokenHtml)?.[1]
    if (!vqd) return []
    const { response: resp, text } = await fetchTextBounded(
      `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://duckduckgo.com/' } },
    )
    if (!resp.ok) return []
    const data = asRecord(JSON.parse(text))
    const list: unknown[] = Array.isArray(data.results) ? data.results : []
    const out: ImageSearchResult[] = []
    for (const item of list.slice(0, maxResults)) {
      const img = asRecord(item)
      const imageUrl = String(img.image ?? '')
      if (!imageUrl || COPYRIGHT_HOSTS.some((d) => imageUrl.toLowerCase().includes(d))) continue
      const entry: ImageSearchResult = {
        title: String(img.title ?? ''),
        imageUrl,
        sourceUrl: String(img.url ?? ''),
        source: safeHost(img.url),
      }
      if (typeof img.width === 'number') entry.width = img.width
      if (typeof img.height === 'number') entry.height = img.height
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

// ── utils ───────────────────────────────────────────────────────────

async function fetchTextBounded(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? SEARCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_SEARCH_BODY_BYTES)
      throw new Error('Search unavailable')
    if (!response.body) return { response, text: '' }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_SEARCH_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Search unavailable')
      }
      chunks.push(value)
    }
    const joined = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { response, text: new TextDecoder().decode(joined) }
  } finally {
    clearTimeout(t)
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .trim()
}

function decodeDuckUrl(href: string): string {
  // DuckDuckGo result links are often /l/?uddg=<encoded>
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) return decodeURIComponent(m[1]!)
  return href.startsWith('http') ? href : ''
}
