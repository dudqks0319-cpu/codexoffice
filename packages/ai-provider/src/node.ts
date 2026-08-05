/**
 * Node/Electron-main entrypoint. Renderer and shared code must import the
 * browser-safe package root instead so Vite never traverses the Codex SDK or
 * node:fs/node:child_process authentication helpers.
 */
export * from './index'
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
export {
  configureCodexExecutable,
  configureCodexHome,
  packagedCodexExecutablePath,
  resolveCodexExecutable,
} from './codex-executable'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiTimeoutError,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'
export {
  acquireAiRequest,
  AiRequestGateError,
  createAiRequestGate,
  createAiTurnController,
  runIfAiTurnActive,
} from './request-gate'
export type { AiRequestGateOptions, AiRequestLease } from './request-gate'
