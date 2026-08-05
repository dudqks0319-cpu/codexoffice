import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_IMAGE_MAX_BYTES,
  CODEX_IMAGE_MAX_PROMPT_BYTES,
  CodexImageError,
  CodexImageGenerator,
  codexImageAppServerArgs,
  type CodexAppServerClientLike,
  type CodexAppServerNotification,
  type CodexImageGeneratorOptions,
} from '../src/node'

function png(width = 32, height = 24): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

class FakeClient implements CodexAppServerClientLike {
  readonly calls: Array<{ method: string; params: unknown }> = []
  readonly events = new EventEmitter()
  stopped = false
  account: unknown = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
  capabilities: unknown = { imageGeneration: true, namespaceTools: false, webSearch: false }
  turnStart: unknown = { turn: { id: 'turn-1' } }
  onTurnStart?: (client: FakeClient) => void

  async start(): Promise<void> {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'account/read') return this.account
    if (method === 'modelProvider/capabilities/read') return this.capabilities
    if (method === 'thread/start') {
      const cwd = (params as { cwd: string }).cwd
      return {
        thread: { id: 'thread-1', cwd, ephemeral: true },
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        cwd,
        runtimeWorkspaceRoots: [cwd],
        instructionSources: [],
      }
    }
    if (method === 'turn/start') {
      queueMicrotask(() => this.onTurnStart?.(this))
      return this.turnStart
    }
    return {}
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.events.on('notification', listener)
    return () => this.events.off('notification', listener)
  }

  notify(method: string, params: unknown): void {
    this.events.emit('notification', { method, params })
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

function completedClient(image = png()): FakeClient {
  const client = new FakeClient()
  client.onTurnStart = () => {
    client.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
    client.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'completed',
        result: image.toString('base64'),
        savedPath: null,
      },
    })
    client.notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    })
  }
  return client
}

function generatorWith(
  create: () => FakeClient,
  options: Partial<CodexImageGeneratorOptions> = {},
): CodexImageGenerator {
  return new CodexImageGenerator({
    isEnabled: () => true,
    resolveExecutable: () => '/trusted/codex-0.146',
    createClient: create,
    ...options,
  })
}

function request(requestId = 'request-1') {
  return {
    requestId,
    subjectId: 'subject-hash-1',
    prompt: 'A calm blue landscape',
    userConfirmed: true,
  }
}

async function expectCode(promise: Promise<unknown>, code: CodexImageError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'CodexImageError', code })
}

describe('Codex App Server image generation core', () => {
  it('keeps the App Server isolated and returns one bounded image', async () => {
    const client = completedClient()
    const result = await generatorWith(() => client).generate(request())

    expect(result).toMatchObject({
      requestId: 'request-1',
      mime: 'image/png',
      width: 32,
      height: 24,
      base64: png().toString('base64'),
    })
    expect(result.bytes.equals(png())).toBe(true)
    expect(client.stopped).toBe(true)
    expect(client.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    })
    expect(client.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(codexImageAppServerArgs()).toContain('image_generation')
    expect(codexImageAppServerArgs()).toContain('shell_tool')
  })

  it('fails closed without global enablement and explicit confirmation', async () => {
    const disabled = new CodexImageGenerator({ isEnabled: () => false })
    await expectCode(disabled.generate(request()), 'IMAGE_DISABLED')
    await expectCode(
      generatorWith(() => completedClient()).generate({ ...request(), userConfirmed: false }),
      'IMAGE_CONFIRMATION_REQUIRED',
    )
  })

  it('rejects a pre-aborted caller before reserving quota or starting App Server', async () => {
    const client = completedClient()
    const controller = new AbortController()
    controller.abort()
    await expectCode(
      generatorWith(() => client).generate(request(), controller.signal),
      'IMAGE_CANCELLED',
    )
    expect(client.calls).toEqual([])
  })

  it('requires a ChatGPT account and the provider image capability', async () => {
    const apiKey = new FakeClient()
    apiKey.account = { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
    await expectCode(generatorWith(() => apiKey).generate(request()), 'IMAGE_SIGN_IN_REQUIRED')

    const unsupported = new FakeClient()
    unsupported.capabilities = {
      imageGeneration: false,
      namespaceTools: false,
      webSearch: false,
    }
    await expectCode(
      generatorWith(() => unsupported).generate(request('request-2')),
      'IMAGE_UNAVAILABLE',
    )
  })

  it('rejects replayed request ids and burst quota overflow', async () => {
    const duplicate = generatorWith(() => completedClient(), {
      quota: { burst: 10, rolling: 10, daily: 10 },
    })
    await duplicate.generate(request())
    await expectCode(duplicate.generate(request()), 'IMAGE_DUPLICATE')

    const quota = generatorWith(() => completedClient(), {
      quota: { burst: 1, rolling: 10, daily: 10 },
    })
    await quota.generate(request('quota-1'))
    await expectCode(quota.generate(request('quota-2')), 'IMAGE_QUOTA_EXCEEDED')
  })

  it('rejects oversized prompts and duplicate image results', async () => {
    await expectCode(
      generatorWith(() => completedClient()).generate({
        ...request(),
        prompt: 'x'.repeat(CODEX_IMAGE_MAX_PROMPT_BYTES + 1),
      }),
      'IMAGE_INPUT_INVALID',
    )

    const oversized = completedClient()
    oversized.onTurnStart = () => {
      oversized.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'image-1',
          type: 'imageGeneration',
          status: 'completed',
          result: 'A'.repeat(Math.ceil((CODEX_IMAGE_MAX_BYTES * 4) / 3) + 8),
          savedPath: null,
        },
      })
      oversized.notify('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      })
    }
    await expectCode(
      generatorWith(() => oversized).generate(request('oversized-output')),
      'IMAGE_OUTPUT_INVALID',
    )

    const client = completedClient()
    client.onTurnStart = () => {
      const item = {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'completed',
        result: png().toString('base64'),
        savedPath: null,
      }
      client.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item })
      client.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { ...item, id: 'image-2' },
      })
    }
    await expectCode(
      generatorWith(() => client).generate(request('duplicate-image')),
      'IMAGE_OUTPUT_INVALID',
    )
  })

  it('settles an invalid image item even when turn/completed never arrives', async () => {
    const client = new FakeClient()
    client.onTurnStart = () => {
      client.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'image-1',
          type: 'imageGeneration',
          status: 'completed',
          result: Buffer.from('not-an-image').toString('base64'),
          savedPath: null,
        },
      })
    }
    await expectCode(
      generatorWith(() => client).generate(request('invalid-image-no-turn-complete')),
      'IMAGE_OUTPUT_INVALID',
    )
    expect(client.stopped).toBe(true)
  })

  it('rejects a savedPath outside the mode-0700 temporary directory', async () => {
    const client = completedClient()
    client.onTurnStart = () => {
      client.notify('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'image-1',
          type: 'imageGeneration',
          status: 'completed',
          result: png().toString('base64'),
          savedPath: '/etc/hosts',
        },
      })
      client.notify('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      })
    }
    await expectCode(generatorWith(() => client).generate(request()), 'IMAGE_PROTOCOL_INVALID')
  })

  it('interrupts and cleans up on absolute timeout', async () => {
    const client = new FakeClient()
    let expire: () => void = () => undefined
    const generated = generatorWith(() => client, {
      timeoutMs: 50,
      clock: {
        now: () => 1_000,
        setTimeout: (callback) => {
          expire = callback
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: () => undefined,
      },
    }).generate(request())
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.method === 'turn/start')).toBe(true)
    })
    expire()
    await expectCode(generated, 'IMAGE_TIMEOUT')
    expect(client.stopped).toBe(true)
    expect(client.calls.some((call) => call.method === 'turn/interrupt')).toBe(true)
  })

  it('supports caller cancellation and turn interrupt without retry', async () => {
    const client = new FakeClient()
    const generator = generatorWith(() => client)
    const generated = generator.generate(request())
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.method === 'turn/start')).toBe(true)
    })
    await expectCode(generator.generate(request('request-2')), 'IMAGE_BUSY')
    expect(generator.cancel('request-1')).toBe(true)
    await expectCode(generated, 'IMAGE_CANCELLED')
    expect(client.calls.some((call) => call.method === 'turn/interrupt')).toBe(true)
    expect(client.stopped).toBe(true)
  })
})
