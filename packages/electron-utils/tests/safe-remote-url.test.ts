import { describe, expect, it, vi } from 'vitest'
import { fetchBoundedRemoteImage, isBlockedAddress, isSafeRemoteUrl } from '../src/safe-remote-url'

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '255.255.255.255',
  ])('blocks non-public IPv4 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each(['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1'])('blocks non-public IPv6 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  // URL normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1, so the hex form must be
  // classified through the IPv4 rules rather than read as a plain IPv6 address
  it.each([
    '::ffff:7f00:1', // ::ffff:127.0.0.1
    '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254
    '::ffff:a00:1', // ::ffff:10.0.0.1
    '::7f00:1', // deprecated IPv4-compatible ::127.0.0.1
    '::a9fe:a9fe',
  ])('blocks IPv4-mapped/compatible form %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2001:4860:4860::8888'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false)
    },
  )

  it('treats non-addresses as unsafe', () => {
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})

describe('fetchBoundedRemoteImage', () => {
  const ok = (
    overrides: Partial<{ status: number; headers: Record<string, string>; bytes: Uint8Array }> = {},
  ) => ({
    status: overrides.status ?? 200,
    headers: overrides.headers ?? { 'content-type': 'image/png' },
    bytes: overrides.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })

  it('rejects private DNS answers before transport and pins a public answer', async () => {
    const transport = vi.fn().mockResolvedValue(ok())
    await expect(
      fetchBoundedRemoteImage('https://example.test/a.png', {
        lookupImpl: vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]) as never,
        transport,
      }),
    ).resolves.toBeNull()
    expect(transport).not.toHaveBeenCalled()

    await fetchBoundedRemoteImage('https://example.test/a.png', {
      lookupImpl: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]) as never,
      transport,
    })
    expect(transport.mock.calls[0]?.[1]).toBe('93.184.216.34')
  })

  it('revalidates redirects and rejects redirects to private addresses', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(ok({ status: 302, headers: { location: 'http://127.0.0.1/x' } }))
    await expect(
      fetchBoundedRemoteImage('https://8.8.8.8/start', { transport }),
    ).resolves.toBeNull()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized bodies and non-image MIME types', async () => {
    await expect(
      fetchBoundedRemoteImage('https://8.8.8.8/a', {
        maxBytes: 2,
        transport: vi.fn().mockResolvedValue(ok()),
      }),
    ).resolves.toBeNull()
    await expect(
      fetchBoundedRemoteImage('https://8.8.8.8/a', {
        transport: vi.fn().mockResolvedValue(ok({ bytes: new TextEncoder().encode('not png') })),
      }),
    ).resolves.toBeNull()
    await expect(
      fetchBoundedRemoteImage('https://8.8.8.8/a', {
        transport: vi.fn().mockResolvedValue(ok({ headers: { 'content-type': 'text/html' } })),
      }),
    ).resolves.toBeNull()
  })

  it('propagates cancellation to a slow transport', async () => {
    const controller = new AbortController()
    const transport = vi.fn(
      (_url, _address, _family, options: { signal?: AbortSignal }): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          })
        }),
    )
    const pending = fetchBoundedRemoteImage('https://8.8.8.8/a', {
      signal: controller.signal,
      transport,
    })
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })

  it('enforces an absolute deadline even when a transport never completes', async () => {
    const transport = vi.fn(
      (_url, _address, _family, options: { signal?: AbortSignal }): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('deadline')), {
            once: true,
          })
        }),
    )
    await expect(
      fetchBoundedRemoteImage('https://8.8.8.8/a', { timeoutMs: 5, transport }),
    ).rejects.toThrow('deadline')
  })
})

describe('isSafeRemoteUrl', () => {
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://example.com/x.png',
  ])('rejects non-http scheme %s', async (url) => {
    await expect(isSafeRemoteUrl(url)).resolves.toBe(false)
  })

  it.each([
    'http://127.0.0.1/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://10.0.0.1/x.png',
  ])('rejects literal internal target %s', async (url) => {
    await expect(isSafeRemoteUrl(url)).resolves.toBe(false)
  })

  it.each([
    'http://localhost:8080/x.png',
    'http://foo.localhost/x.png',
    'http://printer.local/x.png',
    'http://metadata.internal/x.png',
  ])('rejects internal hostname %s', async (url) => {
    await expect(isSafeRemoteUrl(url)).resolves.toBe(false)
  })

  it('rejects malformed input and non-strings', async () => {
    await expect(isSafeRemoteUrl('not a url')).resolves.toBe(false)
    await expect(isSafeRemoteUrl(undefined)).resolves.toBe(false)
    await expect(isSafeRemoteUrl(42)).resolves.toBe(false)
  })

  it('allows a public literal address', async () => {
    await expect(isSafeRemoteUrl('https://8.8.8.8/x.png')).resolves.toBe(true)
  })
})
