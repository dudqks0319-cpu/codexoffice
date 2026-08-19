import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { checkReleaseDependencies } from './check-release-dependencies.mjs'
import { verifyAiOperationsEvidence } from './check-ai-operations-evidence.mjs'
import { verifyLibreOfficeEvidence } from './check-libreoffice-evidence.mjs'
import { verifyMicrosoftOfficeEvidence } from './check-microsoft-office-evidence.mjs'
import { verifyUpdateEvidence } from './check-update-evidence.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { normalizeUpdateUrl } = require('../apps/shell/build/electron-builder-config.js')
const SHA_PATTERN = /^[0-9a-f]{40}$/

function check(id, status, detail) {
  return { id, status, detail }
}

export function evaluateMacReleasePreflight(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const run =
    options.execFileSync ??
    ((command, args, runOptions = {}) =>
      execFileSync(command, args, { encoding: 'utf8', ...runOptions }).trim())
  const dependencyCheck = options.checkReleaseDependencies ?? checkReleaseDependencies
  const aiEvidenceCheck = options.verifyAiOperationsEvidence ?? verifyAiOperationsEvidence
  const microsoftOfficeEvidenceCheck =
    options.verifyMicrosoftOfficeEvidence ?? verifyMicrosoftOfficeEvidence
  const libreOfficeEvidenceCheck = options.verifyLibreOfficeEvidence ?? verifyLibreOfficeEvidence
  const updateEvidenceCheck = options.verifyUpdateEvidence ?? verifyUpdateEvidence
  const checks = []

  try {
    const result = dependencyCheck({ repositoryRoot: root, environment })
    checks.push(check('dependencies', 'PASS', `Electron ${result.electron} matches release policy`))
  } catch (error) {
    checks.push(
      check(
        'dependencies',
        'FAIL',
        error instanceof Error ? error.message : 'release dependency validation failed',
      ),
    )
  }

  const head = String(run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
  const status = String(
    run('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }),
  ).trim()
  const declaredSha = environment.GENOFFICE_SOURCE_SHA?.trim().toLowerCase() ?? ''
  if (!SHA_PATTERN.test(declaredSha)) {
    checks.push(check('source-sha', 'HOLD', 'GENOFFICE_SOURCE_SHA is not an exact source SHA'))
  } else if (declaredSha !== head.toLowerCase()) {
    checks.push(check('source-sha', 'FAIL', 'declared source SHA does not match Git HEAD'))
  } else {
    checks.push(check('source-sha', 'PASS', `declared source matches ${head.toLowerCase()}`))
  }
  checks.push(
    status === ''
      ? check('worktree', 'PASS', 'tracked and untracked release inputs are clean')
      : check('worktree', 'FAIL', 'worktree has tracked or untracked changes'),
  )

  const manualEvidenceChecks = [
    {
      id: 'microsoft-office',
      path: environment.GENOFFICE_MICROSOFT_OFFICE_EVIDENCE?.trim() ?? '',
      verifier: microsoftOfficeEvidenceCheck,
      missing: 'source-bound Word, Excel, and PowerPoint manual evidence is required',
      pass: 'source-bound Microsoft Office bidirectional manual QA is verified',
    },
    {
      id: 'libreoffice',
      path: environment.GENOFFICE_LIBREOFFICE_EVIDENCE?.trim() ?? '',
      verifier: libreOfficeEvidenceCheck,
      missing: 'source-bound Writer, Calc, and Impress visual evidence is required',
      pass: 'source-bound LibreOffice bidirectional manual QA is verified',
    },
  ]
  for (const evidence of manualEvidenceChecks) {
    if (!evidence.path) {
      checks.push(check(evidence.id, 'HOLD', evidence.missing))
    } else if (!isAbsolute(evidence.path) || !SHA_PATTERN.test(declaredSha)) {
      checks.push(check(evidence.id, 'FAIL', 'manual compatibility evidence is misconfigured'))
    } else {
      try {
        evidence.verifier(evidence.path, { expectedSourceSha: declaredSha })
        checks.push(check(evidence.id, 'PASS', evidence.pass))
      } catch {
        checks.push(check(evidence.id, 'FAIL', 'manual compatibility evidence failed verification'))
      }
    }
  }

  if (platform !== 'darwin') {
    checks.push(check('signing', 'HOLD', 'macOS release signing requires a macOS host'))
  } else {
    const identities = String(
      run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']),
    )
    const identity = environment.CSC_NAME?.trim() ?? ''
    const validIdentityName = /^[^\r\n"]{1,300}$/.test(identity)
    const signingAuthorized = environment.GENOFFICE_SIGNING_AUTHORIZED === '1'
    const secureTimestamp = environment.GENOFFICE_SIGNING_TIMESTAMP_MODE === 'secure'
    if (!signingAuthorized || !validIdentityName || !secureTimestamp) {
      checks.push(
        check(
          'signing',
          'HOLD',
          'explicit identity, signing authorization, and secure timestamp are required',
        ),
      )
    } else if (!identities.split(/\r?\n/).some((line) => line.includes(`"${identity}"`))) {
      checks.push(
        check('signing', 'FAIL', 'the explicitly selected signing identity is unavailable'),
      )
    } else {
      checks.push(check('signing', 'PASS', 'explicit Developer ID identity is available'))
    }
  }

  const notarizationAuthorized = environment.GENOFFICE_NOTARIZATION_AUTHORIZED === '1'
  const hasKeychainProfile = Boolean(environment.APPLE_KEYCHAIN_PROFILE)
  const hasAppleCredentialTuple = Boolean(
    environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID,
  )
  if (!notarizationAuthorized || (!hasKeychainProfile && !hasAppleCredentialTuple)) {
    checks.push(
      check(
        'notarization',
        'HOLD',
        'explicit authorization and complete local credentials are required',
      ),
    )
  } else {
    checks.push(check('notarization', 'PASS', 'notarization prerequisites are configured'))
  }

  try {
    const updateUrl = normalizeUpdateUrl(environment.GENOFFICE_UPDATE_URL)
    const updateEvidencePath = environment.GENOFFICE_UPDATE_EVIDENCE?.trim() ?? ''
    if (!updateUrl) {
      checks.push(
        updateEvidencePath
          ? check('update', 'FAIL', 'update evidence is configured without a release channel')
          : check('update', 'HOLD', 'GENOFFICE_UPDATE_URL is not configured'),
      )
    } else if (!updateEvidencePath) {
      checks.push(
        check(
          'update',
          'HOLD',
          'HTTPS channel is configured but source-bound success and failure evidence is required',
        ),
      )
    } else if (!isAbsolute(updateEvidencePath) || !SHA_PATTERN.test(declaredSha)) {
      checks.push(check('update', 'FAIL', 'update evidence configuration is invalid'))
    } else {
      try {
        updateEvidenceCheck(updateEvidencePath, {
          expectedSourceSha: declaredSha,
          expectedUpdateUrl: updateUrl,
        })
        checks.push(check('update', 'PASS', 'source-bound N-to-N+1 update exercise is verified'))
      } catch {
        checks.push(check('update', 'FAIL', 'update evidence failed verification'))
      }
    }
  } catch {
    checks.push(check('update', 'FAIL', 'update channel URL violates release policy'))
  }

  const aiEvidencePath = environment.GENOFFICE_AI_OPERATIONS_EVIDENCE?.trim() ?? ''
  if (!aiEvidencePath) {
    checks.push(
      check(
        'ai-operations',
        'HOLD',
        'source-bound provider hard-cap, alert, kill-switch, and aggregate evidence is required',
      ),
    )
  } else if (!isAbsolute(aiEvidencePath) || !SHA_PATTERN.test(declaredSha)) {
    checks.push(check('ai-operations', 'FAIL', 'AI operations evidence configuration is invalid'))
  } else {
    try {
      aiEvidenceCheck(aiEvidencePath, { expectedSourceSha: declaredSha })
      checks.push(check('ai-operations', 'PASS', 'source-bound provider controls are verified'))
    } catch {
      checks.push(check('ai-operations', 'FAIL', 'AI operations evidence failed verification'))
    }
  }

  const verdict = checks.every((entry) => entry.status === 'PASS') ? 'READY' : 'HOLD'
  return { schemaVersion: 1, verdict, checks }
}

export function formatMacReleasePreflight(report) {
  return [
    'MACOS RELEASE PREFLIGHT',
    ...report.checks.map((entry) => `- ${entry.id}: ${entry.status} — ${entry.detail}`),
    `Verdict: ${report.verdict}`,
  ].join('\n')
}

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = evaluateMacReleasePreflight()
  if (hasFlag('--json')) console.log(JSON.stringify(report, null, 2))
  else console.log(formatMacReleasePreflight(report))
  if (hasFlag('--enforce') && report.verdict !== 'READY') process.exitCode = 1
}
