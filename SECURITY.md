# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/dudqks0319-cpu/codexoffice/security/advisories/new)
on this repository. Do not open public issues for security reports. We aim to
acknowledge reports within 72 hours.

## Process Security Posture

All application windows run with the full Electron renderer lockdown:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every
  document window and tab view (docs, sheets, slides, pdf, shell, updater).
- Renderers reach the main process only through typed, runtime-validated IPC
  channels. AI payloads use the same bounded, exact-key validator across Docs,
  Sheets, Slides, PDF-through-Shell, and their standalone entry points.
- Every `shell.openExternal` call goes through a single shared gate
  (`@genoffice/electron-utils` → `safeExternalUrl`) that parses the URL and
  enforces a protocol allowlist (http/https; pdf link annotations additionally
  allow mailto). `file:`, `javascript:`, and custom schemes are always rejected.
- No API keys are hardcoded. Codex authentication stays in an app-private
  account store and is read only by the bundled CLI process; renderers receive
  a normalized logged-in state, never tokens or auth-file contents. Standalone
  Codex configuration, hooks, plugins, rules, and credentials are not reused.

## Threat Model: Codex Model Execution

Codex runs only in the Electron main process through the exact-pinned official
SDK and native CLI. Every office turn uses an empty temporary working directory,
the read-only sandbox, `approval_policy=never`, disabled network/web search, no
configured MCP servers, and a strict structured-output schema. The Codex child
process is therefore a planner, not the document executor. Optional/default
Codex capabilities that could cross this boundary, including shell snapshots,
workspace dependencies, MCP dependency installation, auth elicitation,
Chronicle, updates, plugin sharing, and remote plugins, are explicitly disabled
rather than relying on their current defaults.

Document changes remain behind the existing `AgentLoop`: it validates model
tool names and decoded inputs against the app-provided JSON Schema subset, runs
those tools in renderer state, and returns bounded results on a later model
turn. Images passed to Codex are MIME/count/size checked, written to mode-`0600`
temporary files, and removed in `finally` cleanup. Cancellation, idle/connect
watchdogs, sender teardown, and an absolute 180-second deadline terminate
stalled turns. Raw CLI stderr is normalized before it reaches UI-facing error
paths.

The main process also applies in-memory global concurrency, duplicate-ID,
burst, rolling-hour, daily-request, and daily requested-token limits. Set
`GENOFFICE_AI_DISABLED=1` to fail closed before starting a model turn. These are
defense-in-depth controls for a desktop client, not durable account-wide quota
enforcement: restarting a locally controlled process resets them.

Optional Serper and keyless DuckDuckGo search are separate main-process network
paths with query/result/body, concurrency, burst, daily, and timeout limits.
Remote image retrieval pins each request to a public DNS answer, revalidates
redirects, and enforces byte, time, concurrency, MIME, and file-signature
limits. `GENOFFICE_SEARCH_DISABLED=1` and
`GENOFFICE_REMOTE_IMAGE_DISABLED=1` are trusted-environment kill switches.
Production builds that enable a billable Serper key must still configure a
provider-side budget cap and alert; this local desktop fork cannot enforce a
global account-wide spend ceiling by itself.

## Threat Model: Codex Image Generation

Slides image generation runs through a separate, one-shot Codex App Server
process; the normal structured office provider continues to disable image
generation. The main process requires a per-call usage/cost confirmation,
ChatGPT account and capability checks, an explicit trusted-environment enable
switch (`GENOFFICE_CODEX_IMAGE_GENERATION=1`), replay-resistant request IDs,
single-flight and burst/hour/day quotas, cancellation, and an absolute timeout.
The one-shot thread is ephemeral, read-only, and approval-free. Model-controlled
arbitrary network tools are disabled; provider egress required by Codex remains
available and must be observed in signed-build release testing. Shell, web, MCP,
apps, plugins, skills, hooks, memories, and multi-agent features are disabled.

Only one PNG, JPEG, or WebP result up to 8 MiB and 4096 pixels per dimension is
accepted. File signatures and dimensions are checked from the bounded base64
result, which is authoritative. An optional provider-managed `savedPath` is
validated only as bounded absolute-path metadata and is never dereferenced,
read, retained, or deleted. Electron then fully decodes and re-encodes the
bitmap as bounded PNG before insertion. Codex credentials, process handles, and
the raw generation response stay in main. The renderer receives the same bounded
`RenderSlide` representation used for existing pictures, while the model tool
result receives insertion metadata only. These desktop quotas reset when the app
restarts and therefore do not replace account/provider limits.

## Threat Model: AI-Generated Layout Scripts (slides)

The slides AI can adjust slide layouts by emitting a small script that is
parsed with Acorn and evaluated by a constrained AST interpreter
(`apps/slides/src/renderer/ai/layout-script-interpreter.ts`). The source looks
like a small, synchronous subset of JavaScript for model compatibility, but it
is not passed to `eval`, `Function`, a VM context, a worker, or the JavaScript
engine as executable source.

**What the script can do by design:** read prototype-free JSON copies of
`els`/`canvas`, perform bounded arithmetic/control flow, use explicitly
implemented string/array/Math helpers, and call
`setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log`. Every edit
primitive validates its arguments (element existence, read-only flags, finite
numbers, hex colors) and writes only into an op buffer that is applied through
the same command pipeline as manual edits.

**Interpreter boundary:**

1. Identifiers resolve only in interpreter-owned lexical scopes seeded with the
   documented data and callables. There are no ambient globals, module loader,
   DOM, network, IPC bridge, timers, process APIs, or dynamic code primitives.
2. Property reads are dispatched by value type. Data objects expose own JSON
   fields only; arrays and strings expose a small method allowlist.
   Host prototypes and function properties are never traversed, including
   through computed property names.
3. Calls accept only interpreter-created functions or explicit builtins. A host
   function obtained through a constructor/prototype chain cannot be
   represented.
4. Inputs and values crossing into edit primitives are recursively copied as
   JSON-like, prototype-free data. Errors discard all buffered operations;
   logs are capped.
5. Execution has statement/expression and call-depth limits to bound runaway
   loops or recursion. Model-authored regular expressions are rejected because
   native backtracking cannot be bounded by the interpreter's step counter.

The Electron renderer sandbox remains defense in depth, but it is not the
layout-script security boundary. The interpreter is designed so a layout
script cannot obtain renderer capabilities in the first place.

If you find a way for a layout script to reach anything beyond the injected
primitives (network, storage, IPC channels not reachable by design, or the
main process), that is a vulnerability — please report it.

## Threat Model: Rendering AI-Generated HTML (slides export)

The HTML-to-pptx export pipeline renders AI-generated HTML in a hidden
`BrowserWindow`. That window is treated as hostile content: full renderer
lockdown (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`),
no preload script, no IPC surface — the main process drives it exclusively
through `executeJavaScript` and destroys it under a watchdog timeout.

## Out of Scope

- The cloud AI services this client talks to are operated separately and are
  not part of this repository; issues with them should be reported through the
  service provider's channels.
- Vulnerabilities that require an already-compromised machine or a modified
  binary. This includes the deliberate environment-variable override points
  for local development (`XLSX_SIDECAR_PATH`): setting them
  requires control of the process environment, which is equivalent to code
  execution on the machine.

## Blocking Release Gates

- **Provider/account budget caps and alerts** — owner: fork maintainer; due:
  before the first public release candidate. Configure and observe Codex/OpenAI
  and Serper account-level ceilings; local tests or in-memory limits are not
  operational proof.
- **Image generation enablement smoke** — owner: release maintainer; due: before
  setting `GENOFFICE_CODEX_IMAGE_GENERATION=1` in a distributed build. With the
  target signed-in account, observe image capability, confirmation/cancel,
  successful insertion, quota exhaustion, timeout/cancel cleanup, and the
  provider-side usage/budget controls.
- **Signed package provenance and runtime smoke** — owner: release maintainer;
  due: before the first public release candidate. On every supported OS/CPU,
  verify the signed/notarized installer contains Codex `0.146.0`, uses the
  app-private auth directory, completes one bounded turn, and signs out without
  changing standalone Codex state.
- **Brand asset review** — owner: product maintainer; due: before the first
  public release candidate. Confirm every packaged surface uses the
  Codexoffice name and only the neutral application icon.
