import { describe, expect, it } from 'vitest'
import { listCodexModels } from '../src/codex-models'
import type { CodexAppServerClientLike } from '../src/codex-app-server'

class FakeClient implements CodexAppServerClientLike {
  readonly requests: string[] = []
  stopped = false

  constructor(
    private readonly account: unknown,
    private readonly page: unknown,
  ) {}

  async start(): Promise<void> {}

  async request(method: string): Promise<unknown> {
    this.requests.push(method)
    if (method === 'account/read') return this.account
    if (method === 'model/list') return this.page
    throw new Error('unexpected request')
  }

  onNotification(): () => void {
    return () => {}
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    ...overrides,
  }
}

describe('listCodexModels', () => {
  it('returns the safe visible model subset for a ChatGPT account', async () => {
    const client = new FakeClient(
      { account: { type: 'chatgpt' } },
      { data: [model(), model({ id: 'hidden', model: 'hidden', hidden: true })], nextCursor: null },
    )
    await expect(
      listCodexModels({
        resolveExecutable: () => '/trusted/codex',
        createClient: () => client,
      }),
    ).resolves.toEqual([model()])
    expect(client.requests).toEqual(['account/read', 'model/list'])
    expect(client.stopped).toBe(true)
  })

  it('rejects unauthenticated accounts and malformed model pages', async () => {
    const unsigned = new FakeClient({ account: null }, { data: [], nextCursor: null })
    await expect(
      listCodexModels({ resolveExecutable: () => '/trusted/codex', createClient: () => unsigned }),
    ).rejects.toThrow('Codex is not signed in')

    const malformed = new FakeClient({ account: { type: 'chatgpt' } }, { data: null })
    await expect(
      listCodexModels({ resolveExecutable: () => '/trusted/codex', createClient: () => malformed }),
    ).rejects.toThrow('invalid model list')
  })

  it('drops duplicate and malformed entries', async () => {
    const client = new FakeClient(
      { account: { type: 'chatgpt' } },
      {
        data: [model(), model(), model({ id: 'bad model', model: 'bad model' })],
        nextCursor: null,
      },
    )
    await expect(
      listCodexModels({ resolveExecutable: () => '/trusted/codex', createClient: () => client }),
    ).resolves.toHaveLength(1)
  })
})
