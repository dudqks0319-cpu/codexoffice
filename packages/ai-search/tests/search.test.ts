import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSearchRequestGate, webSearch, imageSearch } from '../src/index'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SERPER_API_KEY
  delete process.env.GENOFFICE_SEARCH_DISABLED
})

function mockFetch(
  handler: (url: string, init?: RequestInit) => { ok: boolean; json?: unknown; text?: string },
) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init)
    const body = r.json === undefined ? (r.text ?? '') : JSON.stringify(r.json)
    return new Response(body, {
      status: r.ok ? 200 : 500,
      headers: r.json === undefined ? undefined : { 'Content-Type': 'application/json' },
    })
  })
}

describe('webSearch (Serper)', () => {
  it('normalizes bounded input and rejects invalid counts before fetching', async () => {
    mockFetch((_url, init) => {
      expect(init?.body).toContain('normalized query')
      return { ok: true, json: { organic: [{ title: 'A', link: 'https://a', snippet: '' }] } }
    })
    process.env.SERPER_API_KEY = 'test-key'
    await webSearch('  normalized   query  ', 1)
    await expect(webSearch('', 1)).rejects.toThrow('Invalid search request')
    await expect(webSearch('q', 11)).rejects.toThrow('Invalid search request')
  })

  it('fails closed at the kill switch before a paid call', async () => {
    process.env.SERPER_API_KEY = 'secret-never-sent'
    process.env.GENOFFICE_SEARCH_DISABLED = '1'
    globalThis.fetch = vi.fn()
    await expect(webSearch('q', 1)).rejects.toThrow('Search unavailable')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('enforces global concurrency, burst, and daily limits across rotated queries', () => {
    const concurrency = createSearchRequestGate({ disabled: () => false, maxConcurrent: 1 })
    const release = concurrency.acquire()
    expect(() => concurrency.acquire()).toThrow('Search unavailable')
    release()

    const burst = createSearchRequestGate({ disabled: () => false, maxBurst: 1, maxDaily: 10 })
    burst.acquire()()
    expect(() => burst.acquire()).toThrow('Search unavailable')

    const daily = createSearchRequestGate({ disabled: () => false, maxBurst: 10, maxDaily: 1 })
    daily.acquire()()
    expect(() => daily.acquire()).toThrow('Search unavailable')
  })

  it('rejects an oversized provider body and falls back without parsing it', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('x'.repeat(2 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('<html></html>'))
    await expect(webSearch('q', 1)).resolves.toEqual({ method: 'duckduckgo', results: [] })
  })
  it('parses organic results + answer box', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    mockFetch((url) => {
      expect(url).toBe('https://google.serper.dev/search')
      return {
        ok: true,
        json: {
          answerBox: { answer: '42' },
          organic: [
            { title: 'A', link: 'https://a.com', snippet: 'sa' },
            { title: 'B', link: 'https://b.com', snippet: 'sb' },
          ],
        },
      }
    })
    const r = await webSearch('meaning of life', 5)
    expect(r.method).toBe('serper')
    expect(r.answer).toBe('42')
    expect(r.results).toHaveLength(2)
    expect(r.results[0]).toEqual({ title: 'A', url: 'https://a.com', snippet: 'sa' })
  })

  it('falls back to DuckDuckGo when no key', async () => {
    mockFetch((url) => {
      expect(url).toContain('duckduckgo.com')
      return {
        ok: true,
        text: '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fx.com">X Title</a>',
      }
    })
    const r = await webSearch('q', 3)
    expect(r.method).toBe('duckduckgo')
    expect(r.results[0]?.url).toBe('https://x.com')
    expect(r.results[0]?.title).toBe('X Title')
  })

  it('falls back when Serper returns malformed JSON', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'https://google.serper.dev/search') {
        return new Response('{', { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('<a class="result__a" href="https://fallback.example">Fallback</a>')
    })
    globalThis.fetch = fetchMock

    const r = await webSearch('q')

    expect(r).toMatchObject({ method: 'duckduckgo', results: [{ title: 'Fallback' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns an empty fallback result when both providers fail', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('downstream unavailable'))

    await expect(webSearch('q')).resolves.toEqual({ method: 'duckduckgo', results: [] })
  })
})

describe('imageSearch (Serper)', () => {
  it('parses images + filters copyright hosts', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    mockFetch((url) => {
      expect(url).toBe('https://google.serper.dev/images')
      return {
        ok: true,
        json: {
          images: [
            {
              title: 'good',
              imageUrl: 'https://cdn.example.com/a.jpg',
              link: 'https://example.com',
              imageWidth: 800,
              imageHeight: 600,
            },
            {
              title: 'paid',
              imageUrl: 'https://gettyimages.com/x.jpg',
              link: 'https://gettyimages.com',
            },
          ],
        },
      }
    })
    const r = await imageSearch('cats', 8)
    expect(r.method).toBe('serper')
    expect(r.images).toHaveLength(1) // getty is filtered out
    expect(r.images[0]).toMatchObject({
      imageUrl: 'https://cdn.example.com/a.jpg',
      width: 800,
      height: 600,
    })
  })

  it('uses DuckDuckGo when no key is configured', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://duckduckgo.com/?')) {
        return new Response('vqd="123-456"')
      }
      return Response.json({
        results: [
          {
            title: 'cat',
            image: 'https://cdn.example/cat.jpg',
            url: 'https://example.com/cat',
            width: 640,
            height: 480,
          },
        ],
      })
    })
    globalThis.fetch = fetchMock

    const r = await imageSearch('cats')

    expect(r).toMatchObject({
      method: 'duckduckgo',
      images: [{ imageUrl: 'https://cdn.example/cat.jpg', source: 'example.com' }],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back after a malformed Serper response and tolerates a missing DuckDuckGo token', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ images: 'invalid' }))
      .mockResolvedValueOnce(new Response('<html>no token</html>'))

    await expect(imageSearch('cats')).resolves.toEqual({ method: 'duckduckgo', images: [] })
  })

  it('returns an empty fallback when image-search providers fail downstream', async () => {
    process.env.SERPER_API_KEY = 'test-key'
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Serper unavailable'))
      .mockRejectedValueOnce(new Error('DuckDuckGo unavailable'))

    await expect(imageSearch('cats')).resolves.toEqual({ method: 'duckduckgo', images: [] })
  })
})
