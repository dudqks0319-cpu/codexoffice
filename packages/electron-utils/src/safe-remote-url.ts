/// SSRF gate for main-process fetches whose target is influenced by untrusted
/// input — most importantly AI tool calls, where a poisoned web-search result
/// can steer the model into requesting an internal address. Every hop of a
/// redirect chain has to pass, because validating only the initial URL lets a
/// public host bounce the request to loopback or a cloud metadata endpoint.

import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

/**
 * Non-public address ranges. BlockList does the range math and maps
 * ::ffff:0:0/96 addresses back onto the IPv4 rules, which hand-rolled string
 * checks get wrong for normalized forms such as [::ffff:127.0.0.1], whose
 * hostname becomes ::ffff:7f00:1.
 */
const blockedAddresses = (() => {
  const list = new BlockList()
  list.addSubnet('0.0.0.0', 8) // "this network"
  list.addSubnet('10.0.0.0', 8) // private
  list.addSubnet('100.64.0.0', 10) // carrier NAT
  list.addSubnet('127.0.0.0', 8) // loopback
  list.addSubnet('169.254.0.0', 16) // link-local (cloud metadata)
  list.addSubnet('172.16.0.0', 12) // private
  list.addSubnet('192.0.0.0', 24) // IETF protocol assignments
  list.addSubnet('192.168.0.0', 16) // private
  list.addSubnet('198.18.0.0', 15) // benchmarking
  list.addSubnet('224.0.0.0', 4) // multicast
  list.addSubnet('240.0.0.0', 4) // reserved + broadcast
  list.addAddress('::', 'ipv6') // unspecified
  list.addAddress('::1', 'ipv6') // loopback
  list.addSubnet('::', 96, 'ipv6') // deprecated IPv4-compatible (::127.0.0.1)
  list.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64
  list.addSubnet('fc00::', 7, 'ipv6') // unique local
  list.addSubnet('fe80::', 10, 'ipv6') // link-local
  list.addSubnet('ff00::', 8, 'ipv6') // multicast
  return list
})()

/** Hostname suffixes that never denote a public host. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal']

/** True when `ip` is a literal address outside the public ranges (non-addresses count as unsafe). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  return blockedAddresses.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

/**
 * True when the URL is http(s) and its host is public. Literal addresses are
 * checked directly; hostnames are resolved and every returned address must pass,
 * so a name pointing at an internal address is rejected.
 *
 * This is suitable for classification only. Network fetches influenced by
 * untrusted input must use `fetchBoundedRemoteImage`, which pins the validated
 * DNS answer to the request.
 */
export async function isSafeRemoteUrl(raw: unknown): Promise<boolean> {
  if (typeof raw !== 'string') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // URL keeps IPv6 literals bracketed; isIP does not accept the brackets
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '') return false
  if (isIP(host)) return !isBlockedAddress(host)
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false
  try {
    const addrs = await lookup(host, { all: true })
    return addrs.length > 0 && addrs.every((a) => !isBlockedAddress(a.address))
  } catch {
    return false
  }
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface BoundedRemoteImage {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
}

interface RemoteHop {
  status: number
  headers: Record<string, string | string[] | undefined>
  bytes: Uint8Array
}

export interface FetchBoundedRemoteImageOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  signal?: AbortSignal
  headers?: Record<string, string>
  lookupImpl?: typeof lookup
  /** Test seam. Production always uses the pinned node:http(s) transport below. */
  transport?: (
    url: URL,
    address: string,
    family: number,
    options: {
      maxBytes: number
      timeoutMs: number
      signal?: AbortSignal
      headers?: Record<string, string>
    },
  ) => Promise<RemoteHop>
}

function headerValue(headers: RemoteHop['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function imageMagicMatches(mime: string, bytes: Uint8Array): boolean {
  if (mime === 'image/png')
    return (
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      )
    )
  if (mime === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/gif') {
    const head = Buffer.from(bytes.subarray(0, 6)).toString('ascii')
    return head === 'GIF87a' || head === 'GIF89a'
  }
  return (
    mime === 'image/webp' &&
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
}

async function pinnedTransport(
  url: URL,
  address: string,
  family: number,
  options: {
    maxBytes: number
    timeoutMs: number
    signal?: AbortSignal
    headers?: Record<string, string>
  },
): Promise<RemoteHop> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup: ((
          _hostname: string,
          _opts: unknown,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => callback(null, address, family)) as never,
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy(new Error('Remote image exceeds the byte limit'))
          return
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            response.destroy(new Error('Remote image exceeds the byte limit'))
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          }),
        )
        response.once('error', reject)
      },
    )
    request.setTimeout(options.timeoutMs, () =>
      request.destroy(new Error('Remote image timed out')),
    )
    request.once('error', reject)
    request.end()
  })
}

/**
 * Downloads a bounded public image while pinning each HTTP hop to the exact DNS
 * answer that passed the private-address check. Redirects are resolved and
 * revalidated one at a time, closing the validation/request DNS-rebinding gap.
 */
let activeRemoteImageFetches = 0

export async function fetchBoundedRemoteImage(
  rawUrl: string,
  options: FetchBoundedRemoteImageOptions = {},
): Promise<BoundedRemoteImage | null> {
  if (process.env.GENOFFICE_REMOTE_IMAGE_DISABLED === '1' || activeRemoteImageFetches >= 3)
    return null
  activeRemoteImageFetches++
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(abort, options.timeoutMs ?? 15_000)
  try {
    return await fetchBoundedRemoteImageInner(rawUrl, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', abort)
    activeRemoteImageFetches--
  }
}

async function fetchBoundedRemoteImageInner(
  rawUrl: string,
  options: FetchBoundedRemoteImageOptions,
): Promise<BoundedRemoteImage | null> {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? 5
  const resolve = options.lookupImpl ?? lookup
  const transport = options.transport ?? pinnedTransport
  let current = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL
    try {
      url = new URL(current)
    } catch {
      return null
    }
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (
      !host ||
      host === 'localhost' ||
      BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    )
      return null
    let addresses: Array<{ address: string; family: number }>
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
    else {
      try {
        addresses = await resolve(host, { all: true })
      } catch {
        return null
      }
    }
    if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) return null
    const pinned = addresses[0]!
    const response = await transport(url, pinned.address, pinned.family, {
      maxBytes,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    })
    if (response.bytes.byteLength > maxBytes) return null
    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, 'location')
      if (!location || hop === maxRedirects) return null
      try {
        current = new URL(location, url).toString()
      } catch {
        return null
      }
      continue
    }
    if (response.status < 200 || response.status >= 300) return null
    const mime = (headerValue(response.headers, 'content-type') ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase()
    if (!IMAGE_MIMES.has(mime)) return null
    if (!imageMagicMatches(mime, response.bytes)) return null
    return { bytes: response.bytes, mime: mime as BoundedRemoteImage['mime'] }
  }
  return null
}
