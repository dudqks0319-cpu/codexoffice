/**
 * Node/Electron-main entrypoint. Renderer and shared code must import the
 * browser-safe package root instead so Vite never traverses the Codex SDK or
 * node:fs/node:child_process authentication helpers.
 */
export * from './index'
export {
  AI_JOB_MAX_INPUT_TOKENS,
  AI_JOB_MAX_OUTPUT_TOKENS,
  AI_JOB_MAX_PROVIDER_TURNS,
  AI_TURN_MAX_OUTPUT_TOKENS,
  AiJobBudgetError,
  createAiJobBudgetGate,
  estimateAiStreamInputTokens,
  estimateAiStreamOutputTokens,
  globalAiJobBudgetGate,
} from './ai-job-budget'
export type { AiJobBudgetGateOptions, AiJobTurnLease } from './ai-job-budget'
export { chatForProvider } from './chat'
export { AiCreditsError, sseLines, streamForProvider } from './stream'
export type { StreamCallbacks } from './stream'
export {
  CODEX_MAX_IMAGES,
  CODEX_MAX_IMAGE_BYTES,
  CODEX_MAX_PROMPT_BYTES,
  CODEX_MAX_TOTAL_IMAGE_BYTES,
  streamCodex,
} from './codex'
export type { CodexDependencies } from './codex'
export { getCodexAccountStatus, loginCodex, logoutCodex } from './codex-auth'
export type { CodexAuthDependencies } from './codex-auth'
export { listCodexModels } from './codex-models'
export type { CodexModelDependencies } from './codex-models'
export { CodexAppServerClient } from './codex-app-server'
export type {
  CodexAppServerClientLike,
  CodexAppServerClientOptions,
  CodexAppServerNotification,
} from './codex-app-server'
export {
  CODEX_IMAGE_DEFAULT_TIMEOUT_MS,
  CODEX_IMAGE_MAX_BYTES,
  CODEX_IMAGE_MAX_DIMENSION,
  CODEX_IMAGE_MAX_PROMPT_BYTES,
  CodexImageError,
  CodexImageGenerator,
  codexImageAppServerArgs,
} from './codex-image'
export type {
  CodexImageClock,
  CodexImageErrorCode,
  CodexImageFileSystem,
  CodexImageGeneratorOptions,
  CodexImageQuotaOptions,
  CodexImageRequest,
  CodexImageResult,
} from './codex-image'
export {
  configureCodexExecutable,
  configureCodexHome,
  packagedCodexExecutablePath,
  resolveCodexExecutable,
} from './codex-executable'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_DEFAULT_TURN_TIMEOUT_MS,
  AI_HIGH_REASONING_IDLE_TIMEOUT_MS,
  AI_HIGH_REASONING_TURN_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AI_MAX_REASONING_IDLE_TIMEOUT_MS,
  AI_MAX_REASONING_TURN_TIMEOUT_MS,
  AI_XHIGH_REASONING_IDLE_TIMEOUT_MS,
  AI_XHIGH_REASONING_TURN_TIMEOUT_MS,
  AiTimeoutError,
  aiIdleTimeoutMsForReasoning,
  aiTurnTimeoutMsForReasoning,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'
export {
  acquireAiRequest,
  AiRequestGateError,
  configureAiRequestGateStorage,
  createAiRequestGate,
  createAiTurnController,
  runIfAiTurnActive,
} from './request-gate'
export type { AiRequestGateOptions, AiRequestLease } from './request-gate'
