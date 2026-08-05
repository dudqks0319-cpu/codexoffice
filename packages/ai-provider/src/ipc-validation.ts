import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import type { AiChatRequest, AiStreamRequest } from './types'

export const AI_DEFAULT_MAX_TOKENS = 8192
export const AI_MAX_TOKENS = 32_768
// Allows the provider's 20 MiB decoded image total after base64 expansion, plus bounded text/schema overhead.
export const AI_MAX_REQUEST_BYTES = 30 * 1024 * 1024

const MAX_REQUEST_ID = 128
const MAX_SYSTEM_CHARS = 65_536
const MAX_USER_CHARS = 262_144
const MAX_MESSAGES = 128
const MAX_TEXT_CHARS = 262_144
const MAX_IMAGES = 8
const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024
const MAX_TOOL_CALLS = 128
const MAX_TOOL_RESULTS = 128
const MAX_TOOLS = 128
const MAX_SCHEMA_NODES = 10_000
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_CHARS = 256 * 1024

export class AiRequestValidationError extends Error {
  constructor() {
    super('Invalid AI request')
    this.name = 'AiRequestValidationError'
  }
}

function invalid(): never {
  throw new AiRequestValidationError()
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}

function boundedString(value: unknown, max: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0))
    invalid()
  return value
}

function safeJsonValue(value: unknown, maxChars = MAX_SCHEMA_CHARS): Record<string, unknown> {
  if (!record(value)) invalid()
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) invalid()
    if (current === null || ['string', 'boolean'].includes(typeof current)) return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid()
      return
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1)
      return
    }
    if (!record(current)) invalid()
    for (const [key, child] of Object.entries(current)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid()
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    invalid()
  }
  if (json.length > maxChars) invalid()
  return value
}

function safeToolSchema(value: unknown, depth = 0): Record<string, unknown> {
  const schema = safeJsonValue(value)
  const visit = (node: Record<string, unknown>, level: number): void => {
    if (level > MAX_SCHEMA_DEPTH) invalid()
    const allowed = new Set([
      'type',
      'description',
      'enum',
      'const',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'minLength',
      'maxLength',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
      '$ref',
      'definitions',
    ])
    if (Object.keys(node).some((key) => !allowed.has(key))) invalid()
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== 'string' || !/^#\/definitions\/[A-Za-z0-9_-]+$/.test(node.$ref))
        invalid()
    } else {
      const types = Array.isArray(node.type) ? node.type : [node.type]
      if (
        types.length === 0 ||
        types.some(
          (type) =>
            !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
              String(type),
            ),
        )
      )
        invalid()
    }
    if (node.properties !== undefined) {
      if (!record(node.properties)) invalid()
      for (const child of Object.values(node.properties)) {
        if (!record(child)) invalid()
        visit(child, level + 1)
      }
    }
    if (node.items !== undefined) {
      if (!record(node.items)) invalid()
      visit(node.items, level + 1)
    }
    if (node.definitions !== undefined) {
      if (!record(node.definitions)) invalid()
      for (const child of Object.values(node.definitions)) {
        if (!record(child)) invalid()
        visit(child, level + 1)
      }
    }
  }
  visit(schema, depth)
  return schema
}

function parseToolCall(value: unknown): {
  id: string
  name: string
  input: Record<string, unknown>
} {
  if (!record(value)) invalid()
  exactKeys(value, ['id', 'name', 'input', 'inputError', 'truncated'])
  return {
    id: boundedString(value.id, 256, false),
    name: boundedString(value.name, 128, false),
    input: safeJsonValue(value.input),
  }
}

function parseMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) invalid()
  return value.map((message): AgentMessage => {
    if (!record(message)) invalid()
    if (message.role === 'user') {
      exactKeys(message, ['role', 'text', 'images'])
      const text = boundedString(message.text, MAX_TEXT_CHARS)
      if (message.images === undefined) return { role: 'user', text }
      if (!Array.isArray(message.images) || message.images.length > MAX_IMAGES) invalid()
      const images = message.images.map((image) => {
        if (!record(image)) invalid()
        exactKeys(image, ['base64', 'mime'])
        const mime = boundedString(image.mime, 32, false)
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) invalid()
        return { base64: boundedString(image.base64, MAX_IMAGE_BASE64_CHARS, false), mime }
      })
      return { role: 'user', text, images }
    }
    if (message.role === 'assistant') {
      exactKeys(message, ['role', 'text', 'toolCalls'])
      const text = boundedString(message.text, MAX_TEXT_CHARS)
      if (message.toolCalls === undefined) return { role: 'assistant', text }
      if (!Array.isArray(message.toolCalls) || message.toolCalls.length > MAX_TOOL_CALLS) invalid()
      return { role: 'assistant', text, toolCalls: message.toolCalls.map(parseToolCall) }
    }
    if (message.role === 'tool') {
      exactKeys(message, ['role', 'results'])
      if (!Array.isArray(message.results) || message.results.length > MAX_TOOL_RESULTS) invalid()
      return {
        role: 'tool',
        results: message.results.map((result) => {
          if (!record(result)) invalid()
          exactKeys(result, ['id', 'name', 'output', 'isError'])
          return {
            id: boundedString(result.id, 256, false),
            name: boundedString(result.name, 128, false),
            output: boundedString(result.output, MAX_TEXT_CHARS),
            ...(result.isError === undefined
              ? {}
              : typeof result.isError === 'boolean'
                ? { isError: result.isError }
                : invalid()),
          }
        }),
      }
    }
    return invalid()
  })
}

function parseTools(value: unknown): AgentToolDef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_TOOLS) invalid()
  const names = new Set<string>()
  return value.map((tool) => {
    if (!record(tool)) invalid()
    exactKeys(tool, ['name', 'description', 'inputSchema'])
    const name = boundedString(tool.name, 128, false)
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || names.has(name)) invalid()
    names.add(name)
    return {
      name,
      description: boundedString(tool.description, 16_384),
      inputSchema: safeToolSchema(tool.inputSchema),
    }
  })
}

function enforceSerializedSize(value: unknown): void {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    invalid()
  }
  if (new TextEncoder().encode(json).byteLength > AI_MAX_REQUEST_BYTES) invalid()
}

/** Browser-safe runtime validation for the untrusted renderer-to-main stream payload. */
export function parseAiStreamRequest(value: unknown): AiStreamRequest {
  if (!record(value)) invalid()
  // settings is accepted only for wire compatibility; it is deliberately discarded.
  exactKeys(value, ['requestId', 'settings', 'system', 'messages', 'tools', 'maxTokens'])
  const requestId = boundedString(value.requestId, MAX_REQUEST_ID, false)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)) invalid()
  const maxTokens = value.maxTokens === undefined ? AI_DEFAULT_MAX_TOKENS : value.maxTokens
  if (
    !Number.isInteger(maxTokens) ||
    (maxTokens as number) < 1 ||
    (maxTokens as number) > AI_MAX_TOKENS
  )
    invalid()
  const parsed: AiStreamRequest = {
    requestId,
    settings: value.settings as AiStreamRequest['settings'],
    system: boundedString(value.system, MAX_SYSTEM_CHARS),
    messages: parseMessages(value.messages),
    tools: parseTools(value.tools),
    maxTokens: maxTokens as number,
  }
  enforceSerializedSize(parsed)
  return parsed
}

/** Browser-safe runtime validation for the untrusted renderer-to-main one-shot payload. */
export function parseAiChatRequest(value: unknown): Pick<AiChatRequest, 'system' | 'user'> {
  if (!record(value)) invalid()
  exactKeys(value, ['settings', 'system', 'user'])
  const parsed = {
    system: boundedString(value.system, MAX_SYSTEM_CHARS),
    user: boundedString(value.user, MAX_USER_CHARS),
  }
  enforceSerializedSize(parsed)
  return parsed
}

export function parseAiRequestId(value: unknown): string {
  const requestId = boundedString(value, MAX_REQUEST_ID, false)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)) invalid()
  return requestId
}
