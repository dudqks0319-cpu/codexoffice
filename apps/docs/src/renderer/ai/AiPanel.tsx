import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Block } from '@genoffice/docx-engine'
import {
  AgentLoop,
  composeSkills,
  JobLifecycle,
  type AgentImage,
  type JobSnapshot,
  type JobState,
} from '@genoffice/agent-core'
import type { AiSettings, AttachmentAddResult, AttachmentMeta } from '../../shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'
import type { PmNode } from '../editor/convert'
import { findNumId, type NumIds } from './protocol'
import { markDocSeen } from './tools'
import { createDocsSkill } from './docs-skill'
import { applyRevisionsBy } from '../editor/revisions'
import { DOCS_AGENT_MAX_TURNS, DOCS_CONTINUE_INSTRUCTION } from './continuation'
import { createFilesSkill } from './files-skill'
import { createElectronTransport } from './transport'
import {
  acceptsJobCallback,
  affectedUnitsForTool,
  createDocsJobMetadata,
  createDocsProposal,
  createIsolatedProposalEditor,
  DOCS_AI_MAXIMUM_BUDGET,
  documentRevision,
  persistedToolActivity,
  proposalSourceMatches,
  transitionCurrentJob,
  type DocsProposal,
} from './docs-job'
import { useI18n, t as tModule, aiLangDirective, type StringKey } from '../i18n/locale'
import { Markdown } from '@genoffice/ui'
import { AiComposer, AiTypingIndicator } from '@genoffice/ui'
import { CodexMark } from '../components/icons'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import sendStop from '../assets/send-stop.png'
import attachIcon from '../assets/attach-icon.png'
import {
  IconClock,
  IconNewChat,
  IconPaperclip,
  IconRefresh,
  IconSidebarCollapse,
} from '../components/icons'

interface Snapshot {
  label: string
  time: string
  json: PmNode
}

interface ToolActivity {
  name: string
  summary: string
  /** still executing: rendered as a spinner chip, replaced in place when the tool finishes */
  running?: boolean
  isError?: boolean
  /** Tool output (truncated on the UI side); when set, the row can be expanded for details */
  output?: string
}

/** Max characters of tool output in the UI expansion panel */
const TOOL_OUTPUT_MAX_CHARS = 2000

interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  error?: string
  streaming?: boolean
  turnLimit?: boolean
  /** the run failed and this user message was rolled back out of the model context */
  undelivered?: boolean
  /** the run failed because Codex is signed out — render an inline sign-in button */
  loginRequired?: boolean
  /** tool executions performed during this assistant turn */
  tools?: ToolActivity[]
}

/** clickable starter prompts for the empty state (fill the input, do not send) —
 * blank documents get generation starters, documents with content get edit starters */
const DRAFT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterWeeklyReport',
  'aiStarterLaunchPost',
  'aiStarterEventOutline',
]
const EDIT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterSummarize',
  'aiStarterPolishAll',
  'aiStarterContinue',
]

/** resizable panel width: persisted, clamped so neither pane collapses */
const PANEL_WIDTH_KEY = 'docs-ai-panel-width'
const PANEL_WIDTH_DEFAULT = 360
const PANEL_WIDTH_MIN = 280

function maxPanelWidth(): number {
  return Math.min(720, Math.round(window.innerWidth * 0.6))
}

function clampPanelWidth(w: number): number {
  return Math.min(Math.max(w, PANEL_WIDTH_MIN), maxPanelWidth())
}

function loadPanelWidth(): number {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(saved) && saved > 0 ? clampPanelWidth(saved) : PANEL_WIDTH_DEFAULT
}

/** persisted UI preference: highlight AI edits in yellow and ask for confirmation */
const TRACK_CHANGES_KEY = 'ai-docs-track-changes'

/** Clipboard bitmap MIME → attachment extension (corresponds to ATTACHMENT_IMAGE_EXTS) */
const PASTE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** author name on AI-generated tracked revisions (accept/reject via Review) */
export const AI_REVISION_AUTHOR = 'AI Assistant'

interface AiPanelProps {
  editor: Editor
  blocks: Block[]
  settings: AiSettings
  /** the document has no text yet — the empty-state copy offers drafting instead of editing */
  docEmpty?: boolean
  /** fallback numbering ids for documents created from the blank template */
  numIdFallback?: NumIds | null
  /** preset instruction pushed from the ribbon or start screen; autoRun sends it immediately */
  preset?: { text: string; nonce: number; autoRun?: boolean } | null
  /** false shows only the collapsed rail; the component stays mounted so panel state survives */
  open?: boolean
  /** expand from the collapsed rail */
  onExpand?: () => void
  /** collapse the panel to the sidebar rail */
  onCollapse?: () => void
  /** Absolute path of the currently open file (used for chat-history persistence) */
  filePath?: string | null
}

export function AiPanel({
  editor,
  blocks,
  settings,
  docEmpty,
  numIdFallback,
  preset,
  open = true,
  onExpand,
  onCollapse,
  filePath,
}: AiPanelProps) {
  const { t, lang } = useI18n()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [jobSnapshot, setJobSnapshot] = useState<JobSnapshot | null>(null)
  const [proposal, setProposal] = useState<DocsProposal<PmNode> | null>(null)
  /** Wall-clock start of the current run, drives the elapsed badge */
  const runStartedAtRef = useRef(0)
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [trackChanges, setTrackChanges] = useState(
    () => localStorage.getItem(TRACK_CHANGES_KEY) === '1',
  )
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  // The .ai-dock wrapper owns the animated width (Excel-parity 180ms slide);
  // it tracks the resizable panel width through this variable
  // `open` dep: the aside ref only exists while expanded
  useEffect(() => {
    const dock = asideRef.current?.closest('.ai-dock') as HTMLElement | null
    dock?.style.setProperty('--ai-panel-width', `${panelWidth}px`)
  }, [panelWidth, open])

  // Re-clamp the persisted width when the window shrinks (max is 60% of the window)
  useEffect(() => {
    const onResize = () => setPanelWidth((w) => clampPanelWidth(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  /** Past conversation restored from JSONL (read-only transcript, not fed to the model) */
  const [historicChat, setHistoricChat] = useState<ChatEntry[]>([])
  // bumped on selection/doc changes so the scope hint & quick actions stay fresh
  const [, setScopeTick] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** false once the user scrolls up to read; re-arms near the bottom */
  const stickToBottomRef = useRef(true)
  /** projectId/chatId of the current chat */
  const chatRefIds = useRef<{ projectId: string; chatId: string } | null>(null)

  // latest props for the loop's closures (the loop instance outlives renders)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const numIdFallbackRef = useRef(numIdFallback)
  numIdFallbackRef.current = numIdFallback
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const trackChangesRef = useRef(trackChanges)
  trackChangesRef.current = trackChanges

  /** drop every aiChanged flag; silent = skip undo history (auto-accept path) */
  const clearAiHighlights = (silent = false, target = editorRef.current) => {
    const view = target.view
    let tr = view.state.tr
    let touched = false
    view.state.doc.forEach((node, offset) => {
      if (node.attrs.aiChanged) {
        tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
        touched = true
      }
    })
    if (silent) tr = tr.setMeta('addToHistory', false)
    if (touched) {
      view.dispatch(tr)
      // AI-pipeline housekeeping, not a user edit: keep the freshness baseline current
      markDocSeen(target)
    }
  }
  /** instruction of the in-flight run, labels its rollback snapshot */
  const instructionRef = useRef('')
  /** last sent instruction, for one-click retry */
  const lastInstructionRef = useRef('')
  /** Tool activity of the whole run (with args/output, accumulated across turns) — for full
      transcript persistence, and so persisting needn't do side effects inside a setState updater */
  const runToolsRef = useRef<
    Array<{ name: string; summary: string; isError?: boolean; input?: string; output?: string }>
  >([])
  const jobLifecycleRef = useRef<JobLifecycle | null>(null)
  const proposalRef = useRef<DocsProposal<PmNode> | null>(null)
  const preMutationSnapshotRef = useRef<PmNode | null>(null)
  const executionEditorRef = useRef<Editor>(editor)
  const affectedUnitsRef = useRef<string[]>([])
  const currentGenerationRef = useRef(0)
  const activeGenerationRef = useRef(0)

  const publishJobSnapshot = (snapshot: JobSnapshot | null) => {
    setJobSnapshot(snapshot)
    return snapshot
  }

  const transitionJob = (next: JobState) => {
    const snapshot = transitionCurrentJob(jobLifecycleRef.current, next)
    if (snapshot) publishJobSnapshot(snapshot)
    return snapshot
  }

  const callbackIsCurrent = () =>
    acceptsJobCallback(
      jobLifecycleRef.current,
      activeGenerationRef.current,
      currentGenerationRef.current,
    )

  const disposeExecutionEditor = () => {
    const executionEditor = executionEditorRef.current
    if (executionEditor !== editorRef.current && !executionEditor.isDestroyed)
      executionEditor.destroy()
    executionEditorRef.current = editorRef.current
    preMutationSnapshotRef.current = null
  }

  const updateProposal = (next: DocsProposal<PmNode> | null) => {
    proposalRef.current = next
    setProposal(next)
  }

  // ── Chat-history persistence ────────────────────────────────────────────
  useEffect(() => {
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api) return
    const tempChatId = `unsaved-${Date.now()}`
    void api
      .resolveChat({ filePath: filePath ?? null, tempChatId })
      .then((ids) => {
        chatRefIds.current = ids
        return api.loadChat({ projectId: ids.projectId, chatId: ids.chatId, limit: 200 })
      })
      .then((msgs) => {
        if (msgs.length === 0) return
        setHistoricChat(
          msgs.map((m) => ({
            role: m.role,
            text: m.text,
            tools: m.tools?.map((t) => ({
              name: t.name,
              summary: t.summary,
              isError: t.isError,
              output: t.output ? t.output.slice(0, TOOL_OUTPUT_MAX_CHARS) : undefined,
            })),
          })),
        )
        // restore model context: follow-ups after reopening a file continue the previous conversation (only when the loop is idle with no history)
        loopRef.current?.restore(msgs.map((m) => ({ role: m.role, text: m.text })))
      })
      .catch(() => {
        /* history load failures are silent */
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** After an unsaved document's first save yields a real path, bind the unsaved-* history to that file (recoverable by path on reopen) */
  useEffect(() => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api || !ids || !filePath || !ids.chatId.startsWith('unsaved-')) return
    void api
      .rebindChat({ projectId: ids.projectId, tempChatId: ids.chatId, newFilePath: filePath })
      .then((r) => {
        if (r?.chatId) chatRefIds.current = r
      })
      .catch(() => {
        /* silent */
      })
  }, [filePath])

  const persistMessage = (
    role: 'user' | 'assistant',
    text: string,
    tools?: Array<{
      name: string
      summary: string
      isError?: boolean
      input?: string
      output?: string
    }>,
    attachments?: AttachmentMeta[],
  ) => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!ids || !api) return
    void api
      .appendChat({
        projectId: ids.projectId,
        chatId: ids.chatId,
        role,
        text,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                path: a.path,
                ext: a.ext,
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
      })
      .catch(() => {
        /* silent */
      })
  }

  const patchLastAssistant = (
    patch: Partial<ChatEntry> | ((last: ChatEntry) => Partial<ChatEntry>),
  ) => {
    setChat((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (!last || last.role !== 'assistant') return prev
      next[next.length - 1] = { ...last, ...(typeof patch === 'function' ? patch(last) : patch) }
      return next
    })
  }

  const loopRef = useRef<AgentLoop<PmNode> | null>(null)
  if (!loopRef.current) {
    const numIds = (): NumIds => ({
      bullet: findNumId(blocksRef.current, 'bullet') ?? numIdFallbackRef.current?.bullet ?? null,
      ordered: findNumId(blocksRef.current, 'ordered') ?? numIdFallbackRef.current?.ordered ?? null,
    })
    loopRef.current = new AgentLoop<PmNode>({
      transport: createElectronTransport(() => settingsRef.current),
      systemSuffix: aiLangDirective,
      maxTurns: DOCS_AGENT_MAX_TURNS,
      skill: composeSkills('docs+files', '', [
        createDocsSkill(
          () => executionEditorRef.current,
          numIds,
          () => (trackChangesRef.current ? { author: AI_REVISION_AUTHOR } : undefined),
        ),
        createFilesSkill(() => attachmentsRef.current),
      ]),
      captureSnapshot: () => executionEditorRef.current.getJSON() as PmNode,
      events: {
        onText: (text) => {
          if (callbackIsCurrent()) patchLastAssistant({ text })
        },
        onToolStart: (call) => {
          if (!callbackIsCurrent()) return
          // Live "running" chip: replaced in place by onToolExecuted
          patchLastAssistant((last) => ({
            tools: [
              ...(last.tools ?? []),
              { name: call.name, summary: call.name.replace(/[_-]+/g, ' '), running: true },
            ],
          }))
        },
        onToolExecuted: ({ call, execution, snapshotBefore }) => {
          if (!callbackIsCurrent()) {
            // The stale tool only had access to the disposable proposal editor.
            return
          }
          if (snapshotBefore) {
            preMutationSnapshotRef.current = snapshotBefore
          }
          if (execution.mutated) {
            affectedUnitsRef.current.push(...affectedUnitsForTool(call))
            // tracking off: accept immediately (same tick, so the yellow never paints);
            // tracking on: revisions stay pending, handled in the Review tab
            if (!trackChangesRef.current) clearAiHighlights(true, executionEditorRef.current)
          }
          runToolsRef.current.push({
            name: call.name,
            summary: execution.summary,
            isError: execution.isError,
            output: execution.output,
          })
          patchLastAssistant((last) => {
            // Swap out the running placeholder pushed by onToolStart (parse-fail calls have none)
            const tools = [...(last.tools ?? [])]
            if (tools.at(-1)?.running) tools.pop()
            return {
              tools: [
                ...tools,
                {
                  name: call.name,
                  summary: execution.summary,
                  isError: execution.isError,
                  output: execution.output
                    ? execution.output.slice(0, TOOL_OUTPUT_MAX_CHARS)
                    : undefined,
                },
              ],
            }
          })
        },
        onTurnEnd: () => {
          if (!callbackIsCurrent()) return
          patchLastAssistant({ streaming: false })
          setChat((prev) => [...prev, { role: 'assistant', text: '', streaming: true }])
        },
        onDone: ({ text, cancelled, turnLimit, truncated }) => {
          const lifecycle = jobLifecycleRef.current
          const current = callbackIsCurrent()
          const stopped = cancelled || lifecycle?.snapshot.state === 'CANCELLED' || !current
          if (stopped) {
            disposeExecutionEditor()
            updateProposal(null)
            if (lifecycle && lifecycle.snapshot.state !== 'CANCELLED') transitionJob('CANCELLED')
          } else if (preMutationSnapshotRef.current) {
            const before = preMutationSnapshotRef.current
            const after = executionEditorRef.current.getJSON() as PmNode
            const nextProposal = createDocsProposal({
              proposalId:
                lifecycle!.snapshot.metadata.proposalId ?? lifecycle!.snapshot.metadata.jobId,
              before,
              after,
              affectedUnits: affectedUnitsRef.current,
              warnings: turnLimit
                ? ['The run stopped at its tool-turn limit. Review carefully.']
                : [],
            })
            disposeExecutionEditor()
            updateProposal(nextProposal)
            transitionJob('REVIEW_READY')
          } else {
            disposeExecutionEditor()
            transitionJob('COMPLETED')
          }
          // module-level t: the loop instance is created only once; the component's t goes stale with the first-render closure
          const baseText = turnLimit
            ? [text, tModule('aiTurnLimit')].filter(Boolean).join('\n\n')
            : text || (stopped ? tModule('aiStopped') : '')
          const finalText = truncated
            ? [baseText, tModule('aiTruncatedNote')].filter(Boolean).join('\n\n')
            : baseText
          patchLastAssistant((last) => ({
            streaming: false,
            turnLimit,
            text: finalText || (last.tools?.length ? last.text : tModule('aiNoReply')),
            // A stop mid-tool can leave a running placeholder behind — drop it
            tools: last.tools?.filter((tl) => !tl.running),
          }))
          setBusy(false)
          // Only an explicitly applied proposal may enter the ordinary save pipeline.
          if (!proposalRef.current && !stopped) {
            window.dispatchEvent(new Event('ai-docs-run-done'))
          }
          // persist outside the updater (a double-invoked updater would write history twice); tools stores the whole run's full activity.
          // Edits-only runs (tools ran, no text) persist too, or the whole turn vanishes from the restored transcript
          if (!stopped && (finalText || runToolsRef.current.length > 0)) {
            persistMessage('assistant', finalText, persistedToolActivity(runToolsRef.current))
          }
        },
        onError: (error) => {
          const lifecycle = jobLifecycleRef.current
          const current = callbackIsCurrent()
          disposeExecutionEditor()
          updateProposal(null)
          if (current) transitionJob('FAILED')
          if (!current || lifecycle?.snapshot.state === 'CANCELLED') {
            setBusy(false)
            return
          }
          setChat((prev) => {
            const next = [...prev]
            // the loop rolled this run's user message out of the model context — surface that
            for (let i = next.length - 1; i >= 0; i--) {
              const entry = next[i]!
              if (entry.role === 'user') {
                next[i] = { ...entry, undelivered: true }
                break
              }
            }
            const last = next.at(-1)
            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                streaming: false,
                error,
                tools: last.tools?.filter((tl) => !tl.running),
              }
            }
            return next
          })
          // Signed-out failures get an inline sign-in button; detected via
          // codex status rather than matching the localized error text
          void window.desktop
            .aiCodexStatus()
            .then((status) => {
              if (status.loggedIn) return
              setChat((prev) => {
                const next = [...prev]
                const last = next.at(-1)
                if (last?.role === 'assistant' && last.error) {
                  next[next.length - 1] = { ...last, loginRequired: true }
                }
                return next
              })
            })
            .catch(() => {})
          setBusy(false)
        },
      },
    })
  }

  useEffect(() => {
    if (!preset) return
    if (preset.autoRun) runWith(preset.text)
    else {
      setInput(preset.text)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce])

  // keep the scope hint & quick actions in sync with the editor selection
  useEffect(() => {
    const bump = () => setScopeTick((t) => t + 1)
    editor.on('selectionUpdate', bump)
    editor.on('update', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('update', bump)
    }
  }, [editor])

  // follow the stream, but stop yanking once the user scrolls up to read;
  // `open` dep: re-expanding lands on messages streamed while collapsed
  useEffect(() => {
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
    }
  }, [chat, open])

  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const run = () => runWith(input.trim())

  /** Image attachments are read as base64 and go multimodal with this user message (≤5MB per image, max 20) */
  const MAX_IMAGES_PER_MESSAGE = 20
  const collectImageAttachments = async (): Promise<AgentImage[]> => {
    const imageAtts = attachmentsRef.current.filter((a) => ATTACHMENT_IMAGE_EXTS.has(a.ext))
    const images: AgentImage[] = []
    const failures: string[] = []
    for (const att of imageAtts.slice(0, MAX_IMAGES_PER_MESSAGE)) {
      const result = await window.desktop.readAttachmentImage(att.path)
      if (result.ok && result.base64 && result.mime) {
        images.push({ base64: result.base64, mime: result.mime })
      } else {
        failures.push(result.error ?? t('aiImageReadFail', { name: att.name }))
      }
    }
    if (imageAtts.length > MAX_IMAGES_PER_MESSAGE) {
      failures.push(t('aiTooManyImages', { max: MAX_IMAGES_PER_MESSAGE }))
    }
    if (failures.length > 0) {
      setAttachNotice(failures.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
    return images
  }

  const runWith = (instruction: string, displayInstruction = instruction) => {
    const loop = loopRef.current
    if (
      !instruction ||
      !loop ||
      loop.busy ||
      jobLifecycleRef.current?.snapshot.state === 'PREPARING'
    )
      return
    const sourceSnapshot = editorRef.current.getJSON() as PmNode
    const proposalEditor = createIsolatedProposalEditor(editorRef.current, sourceSnapshot)
    executionEditorRef.current = proposalEditor
    const generation = currentGenerationRef.current + 1
    currentGenerationRef.current = generation
    activeGenerationRef.current = generation
    const provider = settingsRef.current.provider
    const providerSettings = settingsRef.current.providers[provider]
    const jobId = crypto.randomUUID()
    const lifecycle = new JobLifecycle(
      createDocsJobMetadata({
        jobId,
        proposalId: `proposal-${jobId}`,
        model: providerSettings.model || `${provider} default`,
        reasoning: providerSettings.reasoningEffort || 'default',
        sourceHash: documentRevision(sourceSnapshot),
      }),
    )
    jobLifecycleRef.current = lifecycle
    publishJobSnapshot(lifecycle.snapshot)
    transitionJob('PREPARING')
    updateProposal(null)
    preMutationSnapshotRef.current = null
    affectedUnitsRef.current = []
    setInput('')
    instructionRef.current = instruction
    lastInstructionRef.current = instruction
    runToolsRef.current = []
    stickToBottomRef.current = true
    setChat((prev) => [
      ...prev,
      { role: 'user', text: displayInstruction },
      { role: 'assistant', text: '', streaming: true },
    ])
    runStartedAtRef.current = Date.now()
    setBusy(true)
    persistMessage('user', instruction, undefined, attachmentsRef.current)
    // a rejected image read must not strand the run (busy would stay true forever): degrade to a no-image send
    void collectImageAttachments()
      .catch((): AgentImage[] => {
        setAttachNotice(t('aiImagesSendFailed'))
        window.setTimeout(() => setAttachNotice(null), 5000)
        return []
      })
      .then((images) => {
        if (
          !acceptsJobCallback(lifecycle, generation, currentGenerationRef.current, ['PREPARING'])
        ) {
          return
        }
        transitionJob('RUNNING')
        loop.run(instruction, images)
      })
  }

  const cancel = () => {
    currentGenerationRef.current += 1
    transitionJob('CANCELLED')
    loopRef.current?.cancel()
    if (!loopRef.current?.busy) disposeExecutionEditor()
    updateProposal(null)
    setBusy(false)
  }

  const retry = () => runWith(lastInstructionRef.current)

  const continueRun = () => runWith(DOCS_CONTINUE_INSTRUCTION, t('aiContinue'))

  const newChat = () => {
    if (busy) cancel()
    loopRef.current?.reset()
    disposeExecutionEditor()
    setBusy(false)
    setChat([])
    jobLifecycleRef.current = null
    publishJobSnapshot(null)
    updateProposal(null)
    inputRef.current?.focus()
  }

  const copyMessage = (text: string, idx: number) => {
    void navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200)
  }

  const mergeAttachments = (result: AttachmentAddResult | null) => {
    if (!result) return
    if (result.accepted.length > 0) {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...result.accepted.filter((a) => !seen.has(a.path))]
      })
    }
    if (result.rejected.length > 0) {
      setAttachNotice(result.rejected.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
  }

  const pickAttachments = async () => mergeAttachments(await window.desktop.pickAttachments())

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.desktop.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  /** Files pasted into the input: ones with a local path go through regular attachments; pure bitmaps like screenshots hit a temp file first */
  const onPasteFiles = async (files: File[]) => {
    const paths: string[] = []
    for (const f of files) {
      const p = window.desktop.getPathForFile(f)
      if (p) {
        paths.push(p)
        continue
      }
      const ext = PASTE_MIME_EXT[f.type] ?? f.name.split('.').pop()?.toLowerCase() ?? 'bin'
      mergeAttachments(await window.desktop.addPastedImage(await f.arrayBuffer(), ext))
    }
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path))

  const acceptChanges = () => {
    applyRevisionsBy(editorRef.current, AI_REVISION_AUTHOR, 'accept')
    clearAiHighlights()
  }

  const toggleTrackChanges = () => {
    const next = !trackChanges
    setTrackChanges(next)
    localStorage.setItem(TRACK_CHANGES_KEY, next ? '1' : '0')
    // switching off keeps nothing pending: accept whatever is still highlighted
    if (!next) acceptChanges()
  }

  const rollback = (snapshot: Snapshot) => {
    editor.commands.setContent(snapshot.json as never)
    markDocSeen(editor)
    setSnapshots((prev) => prev.filter((s) => s !== snapshot))
    if (jobLifecycleRef.current?.snapshot.state === 'COMMITTED') transitionJob('RESTORED')
  }

  const rejectProposal = () => {
    if (!proposalRef.current) return
    updateProposal(null)
    if (jobLifecycleRef.current?.snapshot.state === 'SOURCE_CHANGED') {
      jobLifecycleRef.current = null
      publishJobSnapshot(null)
    } else {
      transitionJob('CANCELLED')
    }
  }

  const applyProposal = () => {
    const pending = proposalRef.current
    if (!pending || jobLifecycleRef.current?.snapshot.state !== 'REVIEW_READY') return
    if (!proposalSourceMatches(pending, editorRef.current.getJSON())) {
      transitionJob('SOURCE_CHANGED')
      return
    }
    if (!transitionJob('APPLYING')) return
    try {
      if (!editorRef.current.commands.setContent(pending.after as never)) {
        throw new Error('The proposal could not be applied.')
      }
      markDocSeen(editorRef.current)
      setSnapshots((prev) =>
        [
          {
            label: instructionRef.current.slice(0, 40),
            time: new Date().toLocaleTimeString(),
            json: pending.before,
          },
          ...prev,
        ].slice(0, 20),
      )
      updateProposal(null)
      transitionJob('COMMITTED')
      window.dispatchEvent(new Event('ai-docs-run-done'))
    } catch {
      transitionJob('RECOVERY_REQUIRED')
      editorRef.current.commands.setContent(pending.before as never)
      markDocSeen(editorRef.current)
    }
  }

  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  /** drag the panel's right edge to resize; panel is flush with the window's left edge */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const resizer = e.currentTarget
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      setPanelWidth(clampPanelWidth(ev.clientX))
    }
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      setPanelWidth((w) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w)))
        return w
      })
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    // lostpointercapture also fires if the resizer is unmounted mid-drag (panel collapse)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(e.pointerId)
  }

  const selection = editor.state.selection
  let selectedBlocks = 0
  if (!selection.empty) {
    editor.state.doc.forEach((node, offset) => {
      const start = offset + 1
      const end = start + node.nodeSize
      if (selection.from < end && selection.to > start) selectedBlocks += 1
    })
  }
  const scopeLabel = selection.empty
    ? t(docEmpty ? 'aiScopeEmptyDoc' : 'aiScopeCursor')
    : t('aiScopeSelected', { count: selectedBlocks })
  const providerSettings = settings.providers[settings.provider]
  const modelLabel =
    jobSnapshot?.metadata.model ?? (providerSettings.model || `${settings.provider} default`)
  const reasoningLabel =
    jobSnapshot?.metadata.reasoning ?? providerSettings.reasoningEffort ?? 'default'
  const labels =
    lang === 'ko'
      ? {
          affected: '영향 범위',
          warnings: '주의사항',
          apply: '적용',
          reject: '거절',
          review: '적용 전 검토',
          stale: '문서가 변경되어 적용할 수 없습니다.',
        }
      : lang === 'zh' || lang === 'zh-TW'
        ? {
            affected: '影响范围',
            warnings: '注意事项',
            apply: '应用',
            reject: '拒绝',
            review: '应用前审阅',
            stale: '文档已更改，无法应用。',
          }
        : {
            affected: 'Affected units',
            warnings: 'Warnings',
            apply: 'Apply',
            reject: 'Reject',
            review: 'Review before applying',
            stale: 'The document changed, so this proposal cannot be applied.',
          }

  // collapsed: rail only — after all hooks, so the instance and its state survive
  if (!open) {
    return (
      <button className="ai-rail" title={t('appExpandAiPanel')} onClick={onExpand}>
        <CodexMark size={22} />
      </button>
    )
  }

  return (
    <aside
      ref={asideRef}
      style={{ width: '100%' }}
      className={`ai-panel${dragOver ? ' ai-panel-dragover' : ''}${resizing ? ' ai-panel-resizing' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div
        className="ai-panel-resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('aiPanelTitle')}
      />
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <CodexMark size={22} />
          {t('aiPanelTitle')}
        </span>
        <div className="ai-panel-header-actions">
          {chat.length > 0 && (
            <button className="ai-header-btn" onClick={newChat} title={t('aiNewChatTitle')}>
              <IconNewChat size={16} />
            </button>
          )}
          {onCollapse && (
            <button className="ai-header-btn" onClick={onCollapse} title={t('aiCollapseTitle')}>
              <IconSidebarCollapse size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="ai-job-strip" aria-label="AI job status">
        <span
          className={`ai-job-state${jobSnapshot?.state === 'REVIEW_READY' ? ' review' : busy ? ' running' : ''}`}
        >
          {jobSnapshot?.state ?? (busy ? 'RUNNING' : 'READY')}
        </span>
        <span className="ai-job-chip" title={modelLabel}>
          {modelLabel}
        </span>
        <span className="ai-job-chip">{reasoningLabel}</span>
        <span className="ai-job-chip" title={scopeLabel}>
          {scopeLabel}
        </span>
        <span className="ai-job-chip">
          ≤{' '}
          {jobSnapshot?.metadata.maximumBudget.amount.toLocaleString() ??
            DOCS_AI_MAXIMUM_BUDGET.toLocaleString()}{' '}
          {jobSnapshot?.metadata.maximumBudget.unit ?? 'tokens'}
        </span>
      </div>

      <div ref={logRef} className="ai-chat" onScroll={onLogScroll}>
        {/* past conversation (read-only transcript, not fed to the model), shown continuously with the current turn */}
        {historicChat.length > 0 && (
          <>
            {historicChat.map((entry, i) => (
              <div key={`h${i}`} className={`ai-msg ai-msg-${entry.role} ai-msg-historic`}>
                {entry.tools && entry.tools.length > 0 && <ToolChipList tools={entry.tools} />}
                {entry.text && <Markdown text={entry.text} />}
              </div>
            ))}
            <div className="ai-history-sep">{t('aiHistorySep')}</div>
          </>
        )}
        {chat.length === 0 && historicChat.length === 0 && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">
              {t(docEmpty ? 'aiEmptyDraftTitle' : 'aiEmptyTitle')}
            </div>
            <div className="ai-chat-empty-body">
              {t(docEmpty ? 'aiEmptyDraftBody1' : 'aiEmptyBody1')}
              <br />
              {t(docEmpty ? 'aiEmptyDraftBody2' : 'aiEmptyBody2')}
            </div>
            <div className="ai-starter-list">
              {(docEmpty ? DRAFT_STARTER_PROMPTS : EDIT_STARTER_PROMPTS).map((p) => (
                <button
                  key={p}
                  className="ai-starter"
                  onClick={() => {
                    setInput(t(p))
                    inputRef.current?.focus()
                  }}
                >
                  {t(p)}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((entry, i) => {
          if (
            entry.role === 'assistant' &&
            !entry.text &&
            !entry.streaming &&
            !entry.error &&
            !entry.tools?.length
          ) {
            return null
          }
          const isLast = i === chat.length - 1
          // Action row appears once per completed reply: on the turn's final segment only
          // (mid-turn segments have a following assistant entry; the live turn ends when !busy)
          const nextEntry = chat[i + 1]
          const turnEnded = nextEntry ? nextEntry.role === 'user' : !busy
          const showToolbar =
            entry.role === 'assistant' &&
            !entry.streaming &&
            turnEnded &&
            !!(entry.text || entry.error)
          return (
            <div
              key={i}
              className={`ai-msg ai-msg-${entry.role}${entry.role === 'assistant' && entry.streaming ? ' ai-msg-streaming' : ''}`}
            >
              {entry.role === 'assistant' && !entry.text && entry.streaming ? (
                <span className="ai-typing-row">
                  <AiTypingIndicator
                    label={entry.tools?.length ? t('aiWorking') : t('aiThinking')}
                  />
                </span>
              ) : entry.role === 'assistant' ? (
                <Markdown text={entry.text} />
              ) : (
                entry.text
              )}
              {entry.role === 'user' && entry.undelivered && (
                <div className="ai-msg-undelivered">{t('aiUndelivered')}</div>
              )}
              {entry.tools && entry.tools.length > 0 && <ToolChipList tools={entry.tools} />}
              {entry.error && (
                <div className="ai-msg-error">{t('aiErrorPrefix', { error: entry.error })}</div>
              )}
              {entry.loginRequired && (
                <button
                  className="ai-login-btn"
                  onClick={() => void window.desktop.aiCodexLogin().catch(() => undefined)}
                >
                  {t('aiCodexLoginBtn')}
                </button>
              )}
              {showToolbar && (
                <div className="ai-msg-toolbar">
                  {entry.text && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={() => copyMessage(entry.text, i)}
                      aria-label={t('aiCopyReplyTitle')}
                      data-tip={t('aiCopyReplyTitle')}
                    >
                      {copiedIdx === i ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <path
                            d="M14.6113 5.34253C16.0608 5.3428 17.2363 6.518 17.2363 7.96753V15.5066C17.2361 16.956 16.0607 18.1313 14.6113 18.1316H7.07227C5.62267 18.1316 4.44751 16.9561 4.44727 15.5066V7.96753C4.44732 6.51783 5.62255 5.34253 7.07227 5.34253H14.6113ZM7.07227 6.59253C6.31291 6.59253 5.69732 7.20819 5.69727 7.96753V15.5066C5.69751 16.2658 6.31302 16.8816 7.07227 16.8816H14.6113C15.3703 16.8813 15.9861 16.2656 15.9863 15.5066V7.96753C15.9863 7.20835 15.3705 6.5928 14.6113 6.59253H7.07227ZM10.0176 2.8689C10.3626 2.86905 10.6426 3.14882 10.6426 3.4939C10.6425 3.83888 10.3626 4.11874 10.0176 4.1189H4.59961C3.84022 4.1189 3.22461 4.73451 3.22461 5.4939V11.324C3.22433 11.6689 2.94461 11.949 2.59961 11.949C2.25461 11.949 1.97489 11.6689 1.97461 11.324V5.4939C1.97461 4.04415 3.14987 2.8689 4.59961 2.8689H10.0176Z"
                            fill="currentColor"
                          />
                        </svg>
                      )}
                    </button>
                  )}
                  {isLast && !busy && lastInstructionRef.current && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={retry}
                      aria-label={t('aiRegenerateTitle')}
                      data-tip={t('aiRegenerateTitle')}
                    >
                      <IconRefresh size={12} />
                    </button>
                  )}
                </div>
              )}
              {entry.turnLimit && isLast && !busy && (
                <button className="ai-continue-btn" onClick={continueRun}>
                  {t('aiContinue')}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {(proposal || jobSnapshot?.state === 'SOURCE_CHANGED') && (
        <section className="ai-proposal-card" aria-label={labels.review}>
          <div className="ai-proposal-title">{labels.review}</div>
          {jobSnapshot?.state === 'SOURCE_CHANGED' ? (
            <>
              <div className="ai-proposal-warning">{labels.stale}</div>
              <div className="ai-proposal-actions">
                <button type="button" className="ai-proposal-reject" onClick={rejectProposal}>
                  {labels.reject}
                </button>
              </div>
            </>
          ) : proposal ? (
            <>
              <div className="ai-proposal-heading">{labels.affected}</div>
              <ul>
                {proposal.affectedUnits.map((unit) => (
                  <li key={unit}>{unit}</li>
                ))}
              </ul>
              {proposal.warnings.length > 0 && (
                <>
                  <div className="ai-proposal-heading">{labels.warnings}</div>
                  <ul className="ai-proposal-warning">
                    {proposal.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="ai-proposal-actions">
                <button type="button" className="ai-proposal-reject" onClick={rejectProposal}>
                  {labels.reject}
                </button>
                <button type="button" className="ai-proposal-apply" onClick={applyProposal}>
                  {labels.apply}
                </button>
              </div>
            </>
          ) : null}
        </section>
      )}

      {snapshots.length > 0 && (
        <div className="ai-versions">
          <div className="ai-versions-title">
            <IconClock size={12} />
            {t('aiSnapshotsTitle')}
          </div>
          {snapshots.map((s, i) => (
            <div key={i} className="ai-version-row">
              <span className="ai-version-label" title={s.label}>
                <span className="ai-version-time">{s.time}</span>
                {s.label}
              </span>
              <button className="ai-version-rollback" onClick={() => rollback(s)}>
                {t('aiRollback')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ai-composer">
        {attachments.length > 0 && (
          <div className="ai-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="ai-attachment-chip" title={a.path}>
                <IconPaperclip size={11} />
                {a.name}
                <button
                  className="ai-attachment-remove"
                  onClick={() => removeAttachment(a.path)}
                  title={t('aiRemoveAttachmentTitle')}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachNotice && <div className="ai-attach-notice">{attachNotice}</div>}
        <AiComposer
          value={input}
          busy={busy}
          placeholder={t('aiInputPlaceholder')}
          hintIdle={t('aiHintIdle')}
          hintBusy={t('aiHintBusy')}
          hintIdleTitle={t('aiHintIdleTitle')}
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly
          sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
          sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
          stopIcon={<img src={sendStop} alt="" aria-hidden />}
          textareaRef={inputRef}
          onChange={setInput}
          onSend={run}
          onStop={cancel}
          onPasteFiles={(files) => void onPasteFiles(files)}
          footerStart={
            <>
              <button
                className="ai-attach-btn"
                onClick={pickAttachments}
                title={t('aiAttachTitle')}
              >
                <img src={attachIcon} alt="" aria-hidden />
              </button>
              <button
                className={`ai-track-btn${trackChanges ? ' on' : ''}`}
                onClick={toggleTrackChanges}
                title={trackChanges ? t('aiTrackOnTitle') : t('aiTrackOffTitle')}
              >
                <span className="ai-track-dot" aria-hidden />
                {t('aiTrackChanges')}
              </button>
            </>
          }
        />
      </div>
    </aside>
  )
}

/** Tool row list (unified with slides/sheets): dot + summary; expandable details when there's output; arrow shows on hover */
/** Step-row status icons (timeline glyphs: 14px in a 20px slot, 1.6 stroke) */
function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.5 3.5h11M6.5 20.5h11M8 3.5v3.2c0 2.6 4 4.2 4 5.3 0 1.1 4 2.7 4 5.3v3.2M16 3.5v3.2c0 2.6-4 4.2-4 5.3 0 1.1-4 2.7-4 5.3v3.2" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.4 2.4 2.4 4.6-5" />
    </svg>
  )
}

/** Tool activity group: a single quiet summary row
 *  that auto-opens while tools run, auto-collapses into "Worked · N steps" when they finish,
 *  and a manual toggle that always wins. Rows inside are step rows with 1px connectors. */
function ToolChipList({ tools }: { tools: ToolActivity[] }) {
  const { t: tr } = useI18n()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const toggle = (j: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(j)) next.delete(j)
      else next.add(j)
      return next
    })
  }

  const anyRunning = tools.some((tool) => tool.running)
  const open = userOpen ?? anyRunning
  const label = anyRunning ? tr('aiGroupWorking') : tr('aiWorkedSteps', { n: tools.length })

  return (
    <div className="ai-work-group">
      <button
        type="button"
        className={`ai-work-group-summary${anyRunning ? ' running' : ''}`}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        {anyRunning && !open && <span className="ai-tool-chip-spinner" aria-hidden />}
        <span className="ai-work-group-label">{label}</span>
        <span className={`ai-tool-chip-caret${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      <div className={`ai-work-group-body${open ? ' open' : ''}`}>
        <div className="ai-work-group-body-inner">
          {tools.map((tool, j) => {
            const hasOutput = !tool.running && !!tool.output
            const isOpen = expanded.has(j)
            const stepStatus = tool.running ? 'running' : tool.isError ? 'error' : 'done'
            return (
              <div key={j} className="ai-step-row">
                <span className={`ai-step-icon ${stepStatus}`} aria-hidden>
                  <StepIcon status={stepStatus} />
                </span>
                <div className="ai-step-content">
                  {hasOutput ? (
                    <button
                      type="button"
                      className="ai-step-title clickable"
                      title={tool.name}
                      aria-expanded={isOpen}
                      onClick={() => toggle(j)}
                    >
                      {tool.summary}
                    </button>
                  ) : (
                    <span className="ai-step-title" title={tool.name}>
                      {tool.summary}
                    </span>
                  )}
                  {hasOutput && isOpen && (
                    <div className="ai-step-detail">
                      <div className="ai-tool-output">
                        <div className="ai-tool-output-pre">{tool.output}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
