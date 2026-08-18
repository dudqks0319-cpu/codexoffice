import {
  createIpcTransport,
  IPC_STREAM_SILENCE_TIMEOUT_MS,
  type AgentTransport,
} from '@genoffice/agent-core'
import type { AiJobBudgetTicket, AiSettings } from '../../shared/ipc'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the slides preload bridge (window.slidesApi). */
export function createElectronTransport(
  getSettings: () => AiSettings,
  getJobTicket: () => AiJobBudgetTicket | null,
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.slidesApi.onAiStream(listener),
    start: (request) => window.slidesApi.aiStream(request),
    cancel: (requestId) => void window.slidesApi.aiStreamCancel(requestId),
    getSettings,
    getJobTicket,
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
    unknownErrorText: () => t('aiErrUnknown'),
    timeoutErrorText: () => t('aiErrStreamTimeout'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
