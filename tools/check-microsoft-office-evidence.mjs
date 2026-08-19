import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyManualOfficeEvidence } from './check-manual-office-evidence.mjs'

const defaultManifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../qa-artifacts/release-evidence/microsoft-office.json',
)
const requiredAssertions = {
  word: ['noRepairPrompt', 'referencesPreserved', 'bidirectionalEditsPreserved', 'layoutReviewed'],
  excel: ['noRepairPrompt', 'formulasPreserved', 'chartsPreserved', 'stylesReviewed'],
  powerpoint: ['noRepairPrompt', 'mastersPreserved', 'mediaPreserved', 'visualLayoutReviewed'],
}

export function verifyMicrosoftOfficeEvidence(manifestPath = defaultManifest, options = {}) {
  return verifyManualOfficeEvidence(manifestPath, {
    ...options,
    errorPrefix: 'office-evidence',
    suiteKey: 'office',
    requiredAssertions,
    documentExtensions: { word: '.docx', excel: '.xlsx', powerpoint: '.pptx' },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyMicrosoftOfficeEvidence(process.argv[2] ?? defaultManifest, {
      expectedSourceSha: process.env.GENOFFICE_SOURCE_SHA,
    })
    console.log(`[office-evidence] PASS source ${result.sourceSha} tested ${result.testedAt}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : '[office-evidence] verification failed')
    process.exitCode = 1
  }
}
