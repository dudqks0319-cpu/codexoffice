import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyManualOfficeEvidence } from './check-manual-office-evidence.mjs'

const defaultManifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../qa-artifacts/release-evidence/libreoffice.json',
)
const requiredAssertions = {
  writer: [
    'noRepairPrompt',
    'footnotesPreserved',
    'bidirectionalEditsPreserved',
    'visualLayoutReviewed',
  ],
  calc: ['noRepairPrompt', 'formulasPreserved', 'chartsPreserved', 'visualLayoutReviewed'],
  impress: ['noRepairPrompt', 'mastersPreserved', 'mediaPreserved', 'visualLayoutReviewed'],
}

export function verifyLibreOfficeEvidence(manifestPath = defaultManifest, options = {}) {
  return verifyManualOfficeEvidence(manifestPath, {
    ...options,
    errorPrefix: 'libreoffice-evidence',
    suiteKey: 'libreoffice',
    requiredAssertions,
    documentExtensions: { writer: '.docx', calc: '.xlsx', impress: '.pptx' },
    extraManifestKeys: ['structuralCorpusPassed'],
    validateManifestExtras: (manifest, fail) => {
      if (manifest.structuralCorpusPassed !== true) {
        fail('structuralCorpusPassed must be true')
      }
    },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyLibreOfficeEvidence(process.argv[2] ?? defaultManifest, {
      expectedSourceSha: process.env.GENOFFICE_SOURCE_SHA,
    })
    console.log(`[libreoffice-evidence] PASS source ${result.sourceSha} tested ${result.testedAt}`)
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : '[libreoffice-evidence] verification failed',
    )
    process.exitCode = 1
  }
}
