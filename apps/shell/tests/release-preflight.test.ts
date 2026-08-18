import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  evaluateMacReleasePreflight,
  formatMacReleasePreflight,
} from '../../../tools/check-macos-release-preflight.mjs'

const sourceSha = '0123456789abcdef0123456789abcdef01234567'
const identity = 'Developer ID Application: Fixture (FIXTURETEAM)'
const repositoryRoot = resolve(import.meta.dirname, '../../..')

function commandFixture(options: { dirty?: boolean; identityAvailable?: boolean } = {}) {
  return (command: string, args: string[]) => {
    if (command === '/usr/bin/git' && args[0] === 'rev-parse') return sourceSha
    if (command === '/usr/bin/git' && args[0] === 'status') {
      return options.dirty ? ' M apps/shell/src/main/index.ts' : ''
    }
    if (command === '/usr/bin/security') {
      return options.identityAvailable === false
        ? '0 valid identities found'
        : `1) ABCDEF "${identity}"\n  1 valid identities found`
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
}

function readyEnvironment() {
  return {
    GENOFFICE_SOURCE_SHA: sourceSha,
    CSC_NAME: identity,
    GENOFFICE_SIGNING_AUTHORIZED: '1',
    GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    GENOFFICE_NOTARIZATION_AUTHORIZED: '1',
    APPLE_KEYCHAIN_PROFILE: 'private-profile-name',
    GENOFFICE_UPDATE_URL: 'https://updates.example.com/codexoffice',
  }
}

describe('macOS release preflight', () => {
  it('is mandatory in the canonical release packaging command', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
    expect(packageJson.scripts['release:mac:package']).toBe(
      'npm run release:preflight:enforce && npm run dist:mac',
    )
  })

  it('reports READY only when every prerequisite is present', () => {
    const report = evaluateMacReleasePreflight({
      environment: readyEnvironment(),
      platform: 'darwin',
      execFileSync: commandFixture(),
      checkReleaseDependencies: () => ({ electron: '41.10.3' }),
    })

    expect(report.verdict).toBe('READY')
    expect(report.checks.every((entry) => entry.status === 'PASS')).toBe(true)
    expect(formatMacReleasePreflight(report)).not.toContain('private-profile-name')
  })

  it('fails dirty source and a missing selected identity', () => {
    const report = evaluateMacReleasePreflight({
      environment: readyEnvironment(),
      platform: 'darwin',
      execFileSync: commandFixture({ dirty: true, identityAvailable: false }),
      checkReleaseDependencies: () => ({ electron: '41.10.3' }),
    })

    expect(report.verdict).toBe('HOLD')
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'worktree', status: 'FAIL' }),
        expect.objectContaining({ id: 'signing', status: 'FAIL' }),
      ]),
    )
  })

  it('holds without explicit source, signing, notarization, and update configuration', () => {
    const report = evaluateMacReleasePreflight({
      environment: {},
      platform: 'darwin',
      execFileSync: commandFixture({ identityAvailable: false }),
      checkReleaseDependencies: () => ({ electron: '41.10.3' }),
    })

    expect(report.verdict).toBe('HOLD')
    expect(
      report.checks.filter((entry) => entry.status === 'HOLD').map((entry) => entry.id),
    ).toEqual(['source-sha', 'signing', 'notarization', 'update'])
  })

  it('fails a vulnerable dependency or unsafe update URL without exposing its credentials', () => {
    const environment = {
      ...readyEnvironment(),
      GENOFFICE_UPDATE_URL: 'https://user:super-secret@updates.example.com/releases',
    }
    const report = evaluateMacReleasePreflight({
      environment,
      platform: 'darwin',
      execFileSync: commandFixture(),
      checkReleaseDependencies: () => {
        throw new Error('electron is vulnerable')
      },
    })
    const formatted = formatMacReleasePreflight(report)

    expect(report.verdict).toBe('HOLD')
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dependencies', status: 'FAIL' }),
        expect.objectContaining({ id: 'update', status: 'FAIL' }),
      ]),
    )
    expect(formatted).not.toContain('super-secret')
  })
})
