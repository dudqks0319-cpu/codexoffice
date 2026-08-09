import { access, readFile, stat } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { chatForProvider } from '../src/chat'
import {
  CODEX_MAX_IMAGE_BYTES,
  CODEX_MAX_IMAGES,
  CODEX_MAX_TOTAL_IMAGE_BYTES,
  streamCodex,
  type CodexDependencies,
} from '../src/codex'

const CONFIG = { apiKey: '', model: 'gpt-test', reasoningEffort: 'max' as const }

function completedEnvelope(envelope: unknown): unknown[] {
  return [
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(envelope) },
    },
    { type: 'turn.completed' },
  ]
}

function dependencies(
  events: unknown[],
  inspect?: (
    input: unknown,
    turnOptions: unknown,
    clientOptions: unknown,
    threadOptions: unknown,
  ) => void | Promise<void>,
): CodexDependencies {
  return {
    resolveExecutable: () => '/trusted/codex',
    createClient: (clientOptions) => ({
      startThread: (threadOptions) => ({
        runStreamed: async (input, turnOptions) => {
          await inspect?.(input, turnOptions, clientOptions, threadOptions)
          return {
            events: (async function* () {
              for (const event of events) yield event
            })(),
          }
        },
      }),
    }),
  }
}

function callbacks(signal = new AbortController().signal) {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  const activity = vi.fn()
  return {
    deltas,
    toolCalls,
    activity,
    cb: {
      signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
      onActivity: activity,
    },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Codex provider', () => {
  it('uses hardened SDK options and emits the strict envelope through existing callbacks', async () => {
    const { deltas, toolCalls, activity, cb } = callbacks()
    const inspect = vi.fn((input, turnOptions, clientOptions, threadOptions) => {
      expect(typeof input).toBe('string')
      expect(turnOptions).toMatchObject({ outputSchema: { additionalProperties: false } })
      expect(clientOptions).toMatchObject({
        codexPathOverride: '/trusted/codex',
        config: {
          cli_auth_credentials_store: 'file',
          history: { persistence: 'none' },
          mcp_servers: {},
          plugins: {},
          hooks: {},
          tools: { view_image: false },
          features: {
            apps: false,
            auth_elicitation: false,
            chronicle: false,
            goals: false,
            hooks: false,
            in_app_updates: false,
            multi_agent: false,
            plugin_sharing: false,
            plugins: false,
            remote_plugin: false,
            shell_snapshot: false,
            shell_tool: false,
            skill_mcp_dependency_install: false,
            unified_exec: false,
            workspace_dependencies: false,
          },
        },
      })
      expect(clientOptions.env).not.toHaveProperty('OPENAI_API_KEY')
      expect(clientOptions.env).not.toHaveProperty('CODEX_API_KEY')
      expect(threadOptions).toMatchObject({
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        modelReasoningEffort: 'max',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
      })
    })
    await streamCodex(
      CONFIG,
      'system',
      [{ role: 'user', text: 'hello' }],
      [{ name: 'make_slide', description: 'Make one slide', inputSchema: { type: 'object' } }],
      1000,
      cb,
      dependencies(
        completedEnvelope({
          text: 'Working',
          toolCalls: [{ id: 'call-1', name: 'make_slide', inputJson: '{"title":"Q3"}' }],
        }),
        inspect,
      ),
    )
    expect(deltas).toEqual(['Working'])
    expect(toolCalls).toEqual([{ id: 'call-1', name: 'make_slide', input: { title: 'Q3' } }])
    expect(activity).toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('fails closed if Codex reports any host tool capability event', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [],
        [],
        100,
        cb,
        dependencies([{ type: 'item.started', item: { type: 'image_view', path: '/secret' } }]),
      ),
    ).rejects.toThrow('Codex attempted a disabled capability')
  })

  it('rejects malformed structured output', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [],
        [],
        100,
        cb,
        dependencies([
          { type: 'item.completed', item: { type: 'agent_message', text: '{not-json' } },
        ]),
      ),
    ).rejects.toThrow('malformed structured response')
  })

  it('maps authentication failures without exposing raw CLI output', async () => {
    const { cb } = callbacks()
    const run = streamCodex(
      CONFIG,
      'system',
      [],
      [],
      100,
      cb,
      dependencies([
        {
          type: 'turn.failed',
          error: { message: '401 unauthorized token=super-secret-value' },
        },
      ]),
    )
    await expect(run).rejects.toThrow('Codex is not signed in')
    await expect(run).rejects.not.toThrow('super-secret-value')
  })

  it('rejects tool names that were not offered to Codex', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [],
        [{ name: 'allowed_tool', description: '', inputSchema: {} }],
        100,
        cb,
        dependencies(
          completedEnvelope({
            text: '',
            toolCalls: [{ id: '1', name: 'shell_exec', inputJson: '{}' }],
          }),
        ),
      ),
    ).rejects.toThrow('tool that was not allowed')
  })

  it('rejects prototype-pollution keys in decoded tool input', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [],
        [{ name: 'allowed_tool', description: '', inputSchema: {} }],
        100,
        cb,
        dependencies(
          completedEnvelope({
            text: '',
            toolCalls: [
              {
                id: '1',
                name: 'allowed_tool',
                inputJson: '{"nested":{"__proto__":{"polluted":true}}}',
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow('unsafe tool input key')
  })

  it('rejects decoded tool input that violates nullable and referenced schemas', async () => {
    const schema = {
      type: 'object',
      properties: {
        values: { type: 'array', items: { type: ['number', 'null'] } },
        paragraphs: { $ref: '#/definitions/paragraphs' },
      },
      required: ['values', 'paragraphs'],
      definitions: {
        paragraphs: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    }
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [],
        [{ name: 'edit', description: '', inputSchema: schema }],
        100,
        cb,
        dependencies(
          completedEnvelope({
            text: '',
            toolCalls: [
              { id: '1', name: 'edit', inputJson: '{"values":[1,"bad"],"paragraphs":["ok"]}' },
            ],
          }),
        ),
      ),
    ).rejects.toThrow('does not match its schema')
  })

  it('allows repeated calls to one allowed tool up to the global tool-call cap', async () => {
    const { cb, toolCalls } = callbacks()
    const calls = Array.from({ length: 2 }, (_, index) => ({
      id: String(index),
      name: 'edit',
      inputJson: '{}',
    }))
    await streamCodex(
      CONFIG,
      'system',
      [],
      [{ name: 'edit', description: '', inputSchema: { type: 'object' } }],
      100,
      cb,
      dependencies(completedEnvelope({ text: '', toolCalls: calls })),
    )
    expect(toolCalls).toHaveLength(2)
  })

  it('propagates cancellation into runStreamed and returns a normalized cancellation error', async () => {
    const controller = new AbortController()
    const { cb } = callbacks(controller.signal)
    let sdkSignal: AbortSignal | undefined
    const deps: CodexDependencies = {
      resolveExecutable: () => '/trusted/codex',
      createClient: () => ({
        startThread: () => ({
          runStreamed: async (_input, options) => {
            sdkSignal = options.signal
            return {
              events: (async function* () {
                await new Promise<void>((_resolve, reject) => {
                  options.signal.addEventListener(
                    'abort',
                    () => reject(new Error('secret stderr')),
                    {
                      once: true,
                    },
                  )
                })
                yield undefined
              })(),
            }
          },
        }),
      }),
    }
    const run = streamCodex(CONFIG, 'system', [], [], 100, cb, deps)
    await vi.waitFor(() => expect(sdkSignal).toBeDefined())
    controller.abort()
    await expect(run).rejects.toThrow('Codex request was cancelled')
    expect(sdkSignal?.aborted).toBe(true)
  })

  it('works for one-shot chat without an API key', async () => {
    const result = await chatForProvider(
      'codex',
      CONFIG,
      'system',
      'hello',
      undefined,
      dependencies(completedEnvelope({ text: 'hello back', toolCalls: [] })),
    )
    expect(result).toEqual({ ok: true, content: 'hello back' })
  })
})

describe('Codex image staging limits', () => {
  const image = (bytes: number, mime = 'image/png') => {
    const contents = Buffer.alloc(Math.max(bytes, mime === 'image/png' ? 8 : bytes))
    if (mime === 'image/png') Buffer.from('89504e470d0a1a0a', 'hex').copy(contents)
    return { mime, base64: contents.toString('base64') }
  }

  it('stages images as 0600 files and removes them after the turn', async () => {
    const { cb } = callbacks()
    let stagedPath = ''
    await streamCodex(
      CONFIG,
      'system',
      [{ role: 'user', text: 'inspect', images: [image(8)] }],
      [],
      100,
      cb,
      dependencies(completedEnvelope({ text: 'ok', toolCalls: [] }), async (input) => {
        const entries = input as Array<{ type: string; path?: string }>
        stagedPath = entries[1]!.path!
        expect((await stat(stagedPath)).mode & 0o777).toBe(0o600)
        expect(await readFile(stagedPath)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
      }),
    )
    await expect(access(stagedPath)).rejects.toThrow()
  })

  it('rejects unsupported image types', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [{ role: 'user', text: '', images: [image(1, 'image/svg+xml')] }],
        [],
        100,
        cb,
        dependencies([]),
      ),
    ).rejects.toThrow('does not accept this image type')
  })

  it('rejects image bytes that do not match the declared MIME type', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [{ role: 'user', text: '', images: [{ mime: 'image/png', base64: 'AAAAAAAAAAA=' }] }],
        [],
        100,
        cb,
        dependencies([]),
      ),
    ).rejects.toThrow('does not match its declared type')
  })

  it('rejects too many images', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [
          {
            role: 'user',
            text: '',
            images: Array.from({ length: CODEX_MAX_IMAGES + 1 }, () => image(1)),
          },
        ],
        [],
        100,
        cb,
        dependencies([]),
      ),
    ).rejects.toThrow(`at most ${CODEX_MAX_IMAGES} images`)
  })

  it('rejects an oversized image', async () => {
    const { cb } = callbacks()
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [{ role: 'user', text: '', images: [image(CODEX_MAX_IMAGE_BYTES + 1)] }],
        [],
        100,
        cb,
        dependencies([]),
      ),
    ).rejects.toThrow('image exceeds')
  })

  it('rejects images over the total byte limit', async () => {
    const { cb } = callbacks()
    const perImage = Math.floor(CODEX_MAX_TOTAL_IMAGE_BYTES / 3) + 1
    await expect(
      streamCodex(
        CONFIG,
        'system',
        [{ role: 'user', text: '', images: [image(perImage), image(perImage), image(perImage)] }],
        [],
        100,
        cb,
        dependencies([]),
      ),
    ).rejects.toThrow('byte total limit')
  })
})
