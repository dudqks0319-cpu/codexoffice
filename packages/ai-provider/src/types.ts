import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

export type AiProviderId = 'codex' | 'anthropic' | 'gemini' | 'deepseek' | 'openai' | 'custom'

/** Reasoning levels supported by the current Codex model runtime. */
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface CodexAccountStatus {
  loggedIn: boolean
  authMethod?: 'chatgpt' | 'api-key' | 'unknown'
}

/** Safe subset of a model/list entry exposed to renderer model pickers. */
export interface CodexModelSummary {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
}

export interface AiProviderConfig {
  apiKey: string
  model: string
  reasoningEffort?: CodexReasoningEffort
  /** only used by the custom (OpenAI-compatible) provider */
  baseUrl?: string | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  /** Main-issued, sender-bound budget ticket shared by every provider turn in one UI job. */
  job: AiJobBudgetTicket
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

export interface AiJobBudgetTicket {
  jobId: string
  capability: string
  /** Hard server-side ceiling for cumulative model output in this job. */
  maximumOutputTokens: number
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one */
  type: 'delta' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable safe error cause; lets the renderer localize the message */
  errorCode?: 'timeout' | 'credits' | 'budget'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
}
