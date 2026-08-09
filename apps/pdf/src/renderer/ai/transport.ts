import {
  createIpcTransport,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  type AgentTransport,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the pdf preload bridge (window.pdfApi). */
export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.pdfApi.onAiStream(listener),
    start: (request) => window.pdfApi.aiStream(request),
    cancel: (requestId) => void window.pdfApi.aiStreamCancel(requestId),
    getSettings,
    silenceTimeoutMs: (settings) => {
      const effort = settings.providers.codex.reasoningEffort
      return effort === 'max'
        ? 930_000
        : effort === 'xhigh'
          ? 630_000
          : effort === 'high'
            ? 150_000
            : IPC_STREAM_SILENCE_TIMEOUT_MS
    },
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiUsageLimitReached'),
  })
}
