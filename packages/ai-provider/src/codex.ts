import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Codex, type CodexOptions, type Input, type ThreadOptions } from '@openai/codex-sdk'
import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import { codexChildEnvironment, resolveCodexExecutable } from './codex-executable'
import type { AiProviderConfig, CodexReasoningEffort } from './types'
import {
  AI_CONNECT_TIMEOUT_MS,
  AiTimeoutError,
  aiIdleTimeoutMsForReasoning,
  createStreamWatchdog,
} from './watchdog'
import type { StreamCallbacks } from './stream'

export const CODEX_MAX_IMAGES = 8
export const CODEX_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const CODEX_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const CODEX_MAX_PROMPT_BYTES = 2 * 1024 * 1024

const CODEX_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const CODEX_MAX_TOOL_INPUT_JSON_CHARS = 256 * 1024
const CODEX_MAX_TOOL_INPUT_NODES = 10_000
const CODEX_MAX_TOOL_INPUT_DEPTH = 32
const CODEX_MAX_TOOLS = 128
const ALLOWED_IMAGE_MIMES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
])

interface CodexThreadLike {
  runStreamed(
    input: Input,
    options: { outputSchema: unknown; signal: AbortSignal },
  ): Promise<{ events: AsyncIterable<unknown> }>
}

type GenOfficeThreadOptions = Omit<ThreadOptions, 'modelReasoningEffort'> & {
  modelReasoningEffort?: CodexReasoningEffort
}

interface CodexClientLike {
  startThread(options: GenOfficeThreadOptions): CodexThreadLike
}

export interface CodexDependencies {
  createClient?: (options: CodexOptions) => CodexClientLike
  resolveExecutable?: () => string
  makeTempDirectory?: () => Promise<string>
}

interface CodexEnvelope {
  text: string
  toolCalls: AgentToolCall[]
}

function makeClient(options: CodexOptions): CodexClientLike {
  const client = new Codex(options)
  return {
    // SDK 0.146.0's declaration stops at xhigh, while its runtime forwards the
    // value verbatim and current Codex models accept max. Keep the compatibility
    // cast isolated here until the SDK declaration catches up.
    startThread: (threadOptions) => client.startThread(threadOptions as ThreadOptions),
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTools(tools: AgentToolDef[]): Map<string, Record<string, unknown>> {
  if (tools.length > CODEX_MAX_TOOLS) {
    throw new Error(`Codex accepts at most ${CODEX_MAX_TOOLS} tools per turn`)
  }
  const names = new Map<string, Record<string, unknown>>()
  for (const tool of tools) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(tool.name)) {
      throw new Error('A Codex tool has an invalid name')
    }
    if (names.has(tool.name)) throw new Error(`Duplicate Codex tool name: ${tool.name}`)
    names.set(tool.name, tool.inputSchema)
  }
  return names
}

function decodeImage(base64: string): Buffer {
  if (!base64 || base64.length > Math.ceil((CODEX_MAX_IMAGE_BYTES * 4) / 3) + 4) {
    throw new Error(`A Codex image exceeds the ${CODEX_MAX_IMAGE_BYTES} byte limit`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('A Codex image contains invalid base64 data')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) {
    throw new Error('A Codex image contains non-canonical base64 data')
  }
  if (bytes.length > CODEX_MAX_IMAGE_BYTES) {
    throw new Error(`A Codex image exceeds the ${CODEX_MAX_IMAGE_BYTES} byte limit`)
  }
  return bytes
}

function hasExpectedImageSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png')
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (mime === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return (
    mime === 'image/webp' &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

async function stageInput(
  directory: string,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
): Promise<Input> {
  const stagedImages: Array<{ path: string; mime: string }> = []
  let totalImageBytes = 0
  const promptMessages = [] as unknown[]

  for (const message of messages) {
    if (message.role !== 'user' || !message.images?.length) {
      promptMessages.push(message)
      continue
    }
    const attachments: Array<{ attachmentIndex: number; mime: string }> = []
    for (const image of message.images) {
      if (stagedImages.length >= CODEX_MAX_IMAGES) {
        throw new Error(`Codex accepts at most ${CODEX_MAX_IMAGES} images per turn`)
      }
      const extension = ALLOWED_IMAGE_MIMES.get(image.mime)
      if (!extension) throw new Error('Codex does not accept this image type')
      const bytes = decodeImage(image.base64)
      if (!hasExpectedImageSignature(image.mime, bytes)) {
        throw new Error('A Codex image does not match its declared type')
      }
      totalImageBytes += bytes.length
      if (totalImageBytes > CODEX_MAX_TOTAL_IMAGE_BYTES) {
        throw new Error(`Codex images exceed the ${CODEX_MAX_TOTAL_IMAGE_BYTES} byte total limit`)
      }
      const imagePath = path.join(directory, `image-${stagedImages.length + 1}${extension}`)
      await writeFile(imagePath, bytes, { mode: 0o600, flag: 'wx' })
      stagedImages.push({ path: imagePath, mime: image.mime })
      attachments.push({ attachmentIndex: stagedImages.length, mime: image.mime })
    }
    promptMessages.push({ role: 'user', text: message.text, images: attachments })
  }

  const prompt = [
    'You are the model inside Codexoffice. Follow the supplied system instruction and conversation.',
    'You have no permission to inspect files, run commands, access the network, call MCP/apps/plugins, or execute tools.',
    'The tool definitions below are descriptions only. If a tool is needed, return it in toolCalls; the external AgentLoop is the sole tool executor.',
    'Return only the requested structured JSON envelope. Do not wrap it in markdown. Each toolCalls entry uses inputJson, a JSON-encoded object string matching that tool input schema.',
    JSON.stringify({ system, messages: promptMessages, tools }),
  ].join('\n')
  if (Buffer.byteLength(prompt, 'utf8') > CODEX_MAX_PROMPT_BYTES) {
    throw new Error(`Codex prompt exceeds the ${CODEX_MAX_PROMPT_BYTES} byte limit`)
  }
  if (!stagedImages.length) return prompt
  return [
    { type: 'text', text: prompt },
    ...stagedImages.map((image) => ({ type: 'local_image' as const, path: image.path })),
  ]
}

function maximumTextLength(maxTokens: number): number {
  return Math.max(1, Math.min(500_000, Math.floor(maxTokens) * 4))
}

function outputSchema(toolNames: Map<string, Record<string, unknown>>, maxTokens: number): unknown {
  const maxTextLength = maximumTextLength(maxTokens)
  const nameSchema = toolNames.size
    ? { type: 'string', enum: [...toolNames.keys()] }
    : { type: 'string', maxLength: 0 }
  return {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: maxTextLength },
      toolCalls: {
        type: 'array',
        maxItems: toolNames.size ? CODEX_MAX_TOOLS : 0,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 256 },
            name: nameSchema,
            inputJson: { type: 'string', maxLength: CODEX_MAX_TOOL_INPUT_JSON_CHARS },
          },
          required: ['id', 'name', 'inputJson'],
          additionalProperties: false,
        },
      },
    },
    required: ['text', 'toolCalls'],
    additionalProperties: false,
  }
}

function schemaMatches(
  value: unknown,
  schema: Record<string, unknown>,
  depth = 0,
  definitions: Record<string, unknown> = plainObject(schema.definitions) ? schema.definitions : {},
): boolean {
  if (depth > CODEX_MAX_TOOL_INPUT_DEPTH) return false
  if (typeof schema.$ref === 'string') {
    const match = /^#\/definitions\/([A-Za-z0-9_-]+)$/.exec(schema.$ref)
    const resolved = match ? definitions[match[1]!] : undefined
    return plainObject(resolved) && schemaMatches(value, resolved, depth + 1, definitions)
  }
  if (schema.type === undefined && Object.keys(schema).length === 0) return plainObject(value)
  if (Array.isArray(schema.type)) {
    return schema.type.some(
      (type) =>
        typeof type === 'string' &&
        schemaMatches(value, { ...schema, type }, depth + 1, definitions),
    )
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value)))
    return false
  if ('const' in schema && !Object.is(schema.const, value)) return false
  switch (schema.type) {
    case 'null':
      return value === null
    case 'string':
      return (
        typeof value === 'string' &&
        (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
        (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength)
      )
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
        (typeof schema.maximum !== 'number' || value <= schema.maximum)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return (
        Array.isArray(value) &&
        plainObject(schema.items) &&
        (typeof schema.minItems !== 'number' || value.length >= schema.minItems) &&
        (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) &&
        value.every((item) =>
          schemaMatches(item, schema.items as Record<string, unknown>, depth + 1, definitions),
        )
      )
    case 'object': {
      if (!plainObject(value)) return false
      const properties = plainObject(schema.properties) ? schema.properties : {}
      const required = Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === 'string')
        : []
      if (required.some((key) => !(key in value))) return false
      return Object.entries(value).every(([key, child]) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return false
        const childSchema = properties[key]
        if (childSchema === undefined) return schema.additionalProperties !== false
        return plainObject(childSchema) && schemaMatches(child, childSchema, depth + 1, definitions)
      })
    }
    default:
      return false
  }
}

function parseEnvelope(
  raw: string,
  allowedTools: Map<string, Record<string, unknown>>,
  maxTokens: number,
): CodexEnvelope {
  if (Buffer.byteLength(raw, 'utf8') > CODEX_MAX_RESPONSE_BYTES) {
    throw new Error('Codex returned an oversized structured response')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Codex returned a malformed structured response')
  }
  if (!plainObject(parsed) || typeof parsed.text !== 'string' || !Array.isArray(parsed.toolCalls)) {
    throw new Error('Codex returned a malformed structured response')
  }
  if (Object.keys(parsed).some((key) => key !== 'text' && key !== 'toolCalls')) {
    throw new Error('Codex returned a malformed structured response')
  }
  if (
    parsed.text.length > maximumTextLength(maxTokens) ||
    parsed.toolCalls.length > (allowedTools.size ? CODEX_MAX_TOOLS : 0)
  ) {
    throw new Error('Codex returned an oversized structured response')
  }
  const seenIds = new Set<string>()
  const toolCalls = parsed.toolCalls.map((value): AgentToolCall => {
    if (
      !plainObject(value) ||
      Object.keys(value).some((key) => !['id', 'name', 'inputJson'].includes(key)) ||
      typeof value.id !== 'string' ||
      !value.id ||
      value.id.length > 256 ||
      typeof value.name !== 'string' ||
      typeof value.inputJson !== 'string' ||
      value.inputJson.length > CODEX_MAX_TOOL_INPUT_JSON_CHARS
    ) {
      throw new Error('Codex returned a malformed tool call')
    }
    if (!allowedTools.has(value.name)) throw new Error('Codex returned a tool that was not allowed')
    if (seenIds.has(value.id)) throw new Error('Codex returned duplicate tool call ids')
    seenIds.add(value.id)
    const input = parseToolInputJson(value.inputJson)
    const schema = allowedTools.get(value.name)
    if (!schema || !schemaMatches(input, schema)) {
      throw new Error('Codex returned tool input that does not match its schema')
    }
    return { id: value.id, name: value.name, input }
  })
  return { text: parsed.text, toolCalls }
}

function parseToolInputJson(inputJson: string): Record<string, unknown> {
  let input: unknown
  try {
    input = JSON.parse(inputJson)
  } catch {
    throw new Error('Codex returned malformed tool input JSON')
  }
  if (!plainObject(input)) throw new Error('Codex returned non-object tool input')
  let nodes = 0
  const visit = (value: unknown, depth: number): void => {
    nodes++
    if (nodes > CODEX_MAX_TOOL_INPUT_NODES || depth > CODEX_MAX_TOOL_INPUT_DEPTH) {
      throw new Error('Codex returned overly complex tool input')
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (!plainObject(value)) return
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error('Codex returned an unsafe tool input key')
      }
      visit(child, depth + 1)
    }
  }
  visit(input, 0)
  return input
}

function mappedCodexError(error: unknown, aborted: boolean): Error {
  if (aborted) return new Error('Codex request was cancelled')
  if (error instanceof AiTimeoutError) return error
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (
    message.includes('not logged in') ||
    message.includes('authentication required') ||
    message.includes('unauthorized') ||
    message.includes('401')
  ) {
    return new Error('Codex is not signed in. Sign in and try again.')
  }
  if (message.includes('rate limit') || message.includes('quota') || message.includes('429')) {
    return new Error('Codex is temporarily rate limited. Try again later.')
  }
  if (error instanceof Error && error.message.startsWith('Codex returned')) return error
  if (error instanceof Error && error.message === 'Codex attempted a disabled capability')
    return error
  if (error instanceof Error && error.message.startsWith('Codex prompt')) return error
  if (error instanceof Error && error.message.startsWith('A Codex image')) return error
  if (error instanceof Error && error.message.startsWith('Codex images')) return error
  if (error instanceof Error && error.message.startsWith('Codex accepts')) return error
  if (error instanceof Error && error.message.startsWith('Codex does not accept')) return error
  if (error instanceof Error && error.message.startsWith('Duplicate Codex')) return error
  return new Error('Codex could not complete the request')
}

const HARDENED_CODEX_CONFIG: NonNullable<CodexOptions['config']> = {
  cli_auth_credentials_store: 'file',
  developer_instructions:
    'Operate only as a structured office-response planner. Never inspect files, execute commands, use network tools, invoke external tools, or mutate state. Return only the requested JSON envelope for the host AgentLoop.',
  history: { persistence: 'none' },
  mcp_servers: {},
  plugins: {},
  hooks: {},
  tools: { view_image: false },
  shell_environment_policy: { inherit: 'none' },
  features: {
    apps: false,
    auth_elicitation: false,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    code_mode: false,
    code_mode_host: false,
    computer_use: false,
    chronicle: false,
    goals: false,
    hooks: false,
    image_generation: false,
    in_app_browser: false,
    in_app_updates: false,
    memories: false,
    multi_agent: false,
    multi_agent_v2: false,
    plugins: false,
    plugin_sharing: false,
    remote_plugin: false,
    shell_snapshot: false,
    shell_tool: false,
    skill_mcp_dependency_install: false,
    skill_search: false,
    tool_suggest: false,
    unified_exec: false,
    workspace_dependencies: false,
  },
}

export async function streamCodex(
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  overrides?: CodexDependencies,
): Promise<void> {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0)
    throw new Error('Codex maxTokens must be positive')
  const allowedTools = validateTools(tools)
  const deps = {
    createClient: overrides?.createClient ?? makeClient,
    resolveExecutable: overrides?.resolveExecutable ?? resolveCodexExecutable,
    makeTempDirectory:
      overrides?.makeTempDirectory ?? (() => mkdtemp(path.join(os.tmpdir(), 'genoffice-codex-'))),
  }
  const directory = await deps.makeTempDirectory()
  try {
    await chmod(directory, 0o700)
    const wd = createStreamWatchdog(
      cb.signal,
      AI_CONNECT_TIMEOUT_MS,
      aiIdleTimeoutMsForReasoning(config.reasoningEffort),
    )
    await wd.guard(async () => {
      const input = await stageInput(directory, system, messages, tools)
      const client = deps.createClient({
        codexPathOverride: deps.resolveExecutable(),
        env: codexChildEnvironment(),
        config: HARDENED_CODEX_CONFIG,
      })
      const threadOptions: GenOfficeThreadOptions = {
        sandboxMode: 'read-only',
        workingDirectory: directory,
        skipGitRepoCheck: true,
        modelReasoningEffort: config.reasoningEffort ?? 'low',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        webSearchEnabled: false,
        approvalPolicy: 'never',
        additionalDirectories: [],
      }
      if (config.model) threadOptions.model = config.model
      const thread = client.startThread(threadOptions)
      const streamed = await thread.runStreamed(input, {
        outputSchema: outputSchema(allowedTools, maxTokens),
        signal: wd.signal,
      })
      wd.touch()
      cb.onActivity?.()
      let finalResponse: string | undefined
      for await (const rawEvent of streamed.events) {
        wd.touch()
        cb.onActivity?.()
        if (!plainObject(rawEvent) || typeof rawEvent.type !== 'string') continue
        if (rawEvent.type === 'error') throw new Error('Codex stream failed')
        if (rawEvent.type === 'turn.failed') {
          const error = plainObject(rawEvent.error) ? rawEvent.error.message : undefined
          throw new Error(typeof error === 'string' ? error : 'Codex turn failed')
        }
        if (
          ['item.started', 'item.updated', 'item.completed'].includes(rawEvent.type) &&
          plainObject(rawEvent.item) &&
          !['agent_message', 'reasoning', 'todo_list', 'error'].includes(String(rawEvent.item.type))
        )
          throw new Error('Codex attempted a disabled capability')
        if (
          rawEvent.type === 'item.completed' &&
          plainObject(rawEvent.item) &&
          rawEvent.item.type === 'agent_message' &&
          typeof rawEvent.item.text === 'string'
        ) {
          finalResponse = rawEvent.item.text
        }
      }
      if (!finalResponse) throw new Error('Codex returned no structured response')
      const envelope = parseEnvelope(finalResponse, allowedTools, maxTokens)
      if (envelope.text) cb.onDelta(envelope.text)
      for (const toolCall of envelope.toolCalls) cb.onToolCall(toolCall)
    })
  } catch (error) {
    throw mappedCodexError(error, cb.signal.aborted)
  } finally {
    // Best effort: cleanup must not mask the request's real error. The directory
    // contains only bounded, mode-0600 image copies under the OS temp root.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
