import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LANGS } from '@genoffice/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const repairModule = require('../build/repair-mac-signature.js') as {
  createRepairMacSignature?: (
    dependencies: Record<string, unknown>,
  ) => (context: unknown) => Promise<void>
}
const notarizeModule = require('../build/notarize-dmg.js') as {
  createNotarizeDmg?: (dependencies: Record<string, unknown>) => (result: unknown) => string[]
}
const builderModule = require('../build/electron-builder-config.js') as {
  createBuilderConfig?: (
    env: Record<string, string>,
    dependencies?: { resolveCodexExtraResource: () => { from: string; to: string } },
  ) => {
    mac: { identity?: string | null; notarize?: boolean; electronLanguages?: readonly string[] }
    win: { electronLanguages?: readonly string[] }
    dmg: { sign?: boolean }
    electronDist?: string
    afterPack?: string
    publish?: Array<{ provider: string; url: string; channel: string }>
  }
}
const codexRuntimeModule = require('../../../tools/codex-electron-runtime.cjs') as {
  resolveCodexBuildRuntime?: (options: Record<string, unknown>) => {
    packageName: string
    vendorSource: string
    executable: string
  }
  resolveCodexBuildRuntimeForTarget?: (
    platform: string,
    architecture: string,
    dependencies?: Record<string, unknown>,
  ) => { packageName: string; vendorSource: string; executable: string }
}
const builderEntrypointSource = readFileSync(
  new URL('../electron-builder.cjs', import.meta.url),
  'utf8',
)
const codexResourceFixture = { from: '/fixture/codex/vendor', to: 'codex/vendor' }
const createBuilderConfig = (environment: Record<string, string>) =>
  builderModule.createBuilderConfig!(environment, {
    resolveCodexExtraResource: () => codexResourceFixture,
  })

const runtimeDependencies = (platform: string, architecture: string) => ({
  repoRoot: '/fixture',
  exists: () => true,
  readFile: () => JSON.stringify({ version: `0.146.0-${platform}-${architecture}` }),
  stat: () => ({ isFile: () => true, mode: 0o755 }),
})
const releaseIdentityModule = (() => {
  try {
    return require('../build/release-identity.js') as {
      createReleaseIdentity?: (dependencies: Record<string, unknown>) => {
        writeReceipt: (
          appPath: string,
          metadata: { productName: string; appId: string; version: string },
        ) => Record<string, unknown>
        verifyReceipt: (appPath: string, expectedSourceSha: string) => Record<string, unknown>
      }
    }
  } catch {
    return {} as {
      createReleaseIdentity?: (dependencies: Record<string, unknown>) => {
        writeReceipt: (
          appPath: string,
          metadata: { productName: string; appId: string; version: string },
        ) => Record<string, unknown>
        verifyReceipt: (appPath: string, expectedSourceSha: string) => Record<string, unknown>
      }
    }
  }
})()

function context(identity: string | null | undefined = undefined) {
  return {
    appOutDir: '/isolated/package',
    packager: {
      appInfo: { productFilename: 'Codexoffice' },
      platformSpecificBuildOptions: { identity },
    },
  }
}

function signingDependencies(env: Record<string, string>) {
  let verificationCalls = 0
  const execFileSync = vi.fn((command: string) => {
    if (command === '/usr/bin/codesign') {
      verificationCalls += 1
      if (verificationCalls === 1) throw new Error('unsigned fixture')
      return ''
    }
    if (command === '/usr/bin/security') {
      return '1) "Developer ID Application: Fixture Identity (FIXTURETEAM)"'
    }
    throw new Error(`unexpected command: ${command}`)
  })
  const signAsync = vi.fn(async () => undefined)
  const warn = vi.fn()
  const log = vi.fn()
  return {
    dependencies: {
      env,
      platform: 'darwin',
      existsSync: () => true,
      statSync: () => ({ isFile: () => true, mode: 0o755 }),
      execFileSync,
      signAsync,
      warn,
      log,
    },
    execFileSync,
    signAsync,
    warn,
    log,
  }
}

describe('macOS release side-effect gates', () => {
  it('never queries Keychain or invokes the signer when identity autodiscovery is disabled', async () => {
    expect(repairModule.createRepairMacSignature).toBeTypeOf('function')

    const fixture = signingDependencies({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context())

    expect(
      fixture.execFileSync.mock.calls.filter(([command]) => command === '/usr/bin/security'),
    ).toEqual([])
    expect(fixture.signAsync).not.toHaveBeenCalled()
  })

  it('treats builder identity null as an absolute signing denial', async () => {
    const fixture = signingDependencies({
      CSC_NAME: 'Developer ID Application: Must Not Be Used (SECRETTEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context(null))

    expect(
      fixture.execFileSync.mock.calls.filter(([command]) => command === '/usr/bin/security'),
    ).toEqual([])
    expect(fixture.signAsync).not.toHaveBeenCalled()
  })

  it('does not sign or log identity metadata without explicit signing authorization', async () => {
    const secretIdentity = 'Developer ID Application: Must Not Be Logged (SECRETTEAM)'
    const fixture = signingDependencies({
      CSC_NAME: secretIdentity,
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context())

    expect(fixture.signAsync).not.toHaveBeenCalled()
    expect(JSON.stringify([...fixture.warn.mock.calls, ...fixture.log.mock.calls])).not.toContain(
      secretIdentity,
    )
  })

  it('fails closed without an explicit identity and never falls back to Keychain discovery', async () => {
    const fixture = signingDependencies({
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context())

    expect(
      fixture.execFileSync.mock.calls.filter(([command]) => command === '/usr/bin/security'),
    ).toEqual([])
    expect(fixture.signAsync).not.toHaveBeenCalled()
  })

  it('fails closed without an explicit timestamp mode', async () => {
    const fixture = signingDependencies({
      CSC_NAME: 'Developer ID Application: Fixture (FIXTURETEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context())

    expect(fixture.signAsync).not.toHaveBeenCalled()
  })

  it('passes an explicit secure timestamp policy only after every signing gate is satisfied', async () => {
    const fixture = signingDependencies({
      CSC_NAME: 'Developer ID Application: Fixture (FIXTURETEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })
    const repair = repairModule.createRepairMacSignature!(fixture.dependencies)

    await repair(context())

    expect(fixture.signAsync).toHaveBeenCalledTimes(1)
    const options = fixture.signAsync.mock.calls[0]?.[0] as {
      optionsForFile: () => { timestamp: boolean; hardenedRuntime: boolean }
    }
    expect(options.optionsForFile()).toEqual({ timestamp: true, hardenedRuntime: true })
  })
})

describe('macOS notarization side-effect gate', () => {
  it('never invokes notarytool or stapler without explicit notarization authorization', () => {
    expect(notarizeModule.createNotarizeDmg).toBeTypeOf('function')
    const execFileSync = vi.fn()
    const notarize = notarizeModule.createNotarizeDmg!({
      platform: 'darwin',
      env: { APPLE_KEYCHAIN_PROFILE: 'must-not-be-used' },
      execFileSync,
      warn: vi.fn(),
    })

    expect(notarize({ artifactPaths: ['/isolated/Codexoffice.dmg'] })).toEqual([])
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('fails closed with a generic error when authorization lacks complete credentials', () => {
    const execFileSync = vi.fn()
    const notarize = notarizeModule.createNotarizeDmg!({
      platform: 'darwin',
      env: {
        GENOFFICE_NOTARIZATION_AUTHORIZED: '1',
        APPLE_ID: 'must-not-be-logged@example.invalid',
      },
      execFileSync,
      warn: vi.fn(),
    })

    expect(() => notarize({ artifactPaths: ['/isolated/Codexoffice.dmg'] })).toThrow(
      'notarization prerequisites unavailable',
    )
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('reaches injected notarytool then stapler only after explicit authorization', () => {
    const execFileSync = vi.fn()
    const warn = vi.fn()
    const notarize = notarizeModule.createNotarizeDmg!({
      platform: 'darwin',
      env: {
        GENOFFICE_NOTARIZATION_AUTHORIZED: '1',
        APPLE_KEYCHAIN_PROFILE: 'fixture-profile',
      },
      execFileSync,
      warn,
    })

    expect(notarize({ artifactPaths: ['/isolated/Codexoffice.dmg'] })).toEqual([])
    expect(execFileSync.mock.calls.map(([, args]) => args?.slice(0, 2))).toEqual([
      ['notarytool', 'submit'],
      ['stapler', 'staple'],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-profile')
  })
})

describe('electron-builder signing defaults', () => {
  it('does not expose test helpers on the electron-builder schema object', () => {
    expect(builderEntrypointSource).toContain('module.exports = createBuilderConfig()')
    expect(builderEntrypointSource).not.toContain('module.exports.createBuilderConfig')
  })

  it('uses the installed pinned Electron distribution for offline packaging', () => {
    const config = createBuilderConfig({})

    expect(config.electronDist).toBe('../../node_modules/electron/dist')
  })

  it('packages Chromium locales for every supported UI language and no others', () => {
    const config = createBuilderConfig({})
    const macLocales = config.mac.electronLanguages ?? []
    const windowsLocales = config.win.electronLanguages ?? []
    const toUiLanguage = (locale: string) => {
      if (locale === 'zh_CN' || locale === 'zh-CN') return 'zh'
      if (locale === 'zh_TW' || locale === 'zh-TW') return 'zh-TW'
      if (locale === 'pt_BR' || locale === 'pt-BR') return 'pt'
      if (locale === 'en-US') return 'en'
      return locale
    }

    expect(macLocales.map(toUiLanguage).sort()).toEqual([...LANGS].sort())
    expect(windowsLocales.map(toUiLanguage).sort()).toEqual([...LANGS].sort())
    expect(new Set(macLocales).size).toBe(macLocales.length)
    expect(new Set(windowsLocales).size).toBe(windowsLocales.length)
  })

  it('forces unsigned and non-notarized packaging when signing is not authorized', () => {
    expect(builderModule.createBuilderConfig).toBeTypeOf('function')

    const config = createBuilderConfig({
      CSC_NAME: 'Developer ID Application: Must Not Be Used (SECRETTEAM)',
      APPLE_KEYCHAIN_PROFILE: 'must-not-be-used',
    })

    expect(config.mac.identity).toBeNull()
    expect(config.mac.notarize).toBe(false)
    expect(config.dmg.sign).toBe(false)
    expect(config.afterPack).toBe('build/release-identity.js')
  })

  it('keeps identity null when electron-builder autodiscovery is disabled', () => {
    const config = createBuilderConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_NAME: 'Developer ID Application: Must Not Be Used (SECRETTEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })

    expect(config.mac.identity).toBeNull()
    expect(config.dmg.sign).toBe(false)
  })

  it('enables signing config only with explicit authorization identity and timestamp mode', () => {
    const identity = 'Developer ID Application: Fixture (FIXTURETEAM)'
    const config = createBuilderConfig({
      CSC_NAME: identity,
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
    })

    expect(config.mac.identity).toBe('Fixture (FIXTURETEAM)')
    expect(config.dmg.sign).toBe(true)
    expect(config.mac.notarize).toBe(false)
  })

  it('keeps the builder unsigned for the explicit local no-timestamp mode', () => {
    const config = createBuilderConfig({
      CSC_NAME: 'Developer ID Application: Fixture (FIXTURETEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'none',
      GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN: '1',
    })

    expect(config.mac.identity).toBeNull()
    expect(config.dmg.sign).toBe(false)
    expect(config.mac.notarize).toBe(false)
  })

  it('fails config creation when notarization authorization has incomplete credentials', () => {
    expect(() =>
      createBuilderConfig({
        CSC_NAME: 'Developer ID Application: Fixture (FIXTURETEAM)',
        GENOFFICE_SIGNING_AUTHORIZED: '1',
        GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
        GENOFFICE_NOTARIZATION_AUTHORIZED: '1',
        APPLE_ID: 'incomplete@example.invalid',
      }),
    ).toThrow('notarization prerequisites unavailable')
  })

  it('enables built-in app notarization only with complete explicit authorization', () => {
    const config = createBuilderConfig({
      CSC_NAME: 'Developer ID Application: Fixture (FIXTURETEAM)',
      GENOFFICE_SIGNING_AUTHORIZED: '1',
      GENOFFICE_SIGNING_TIMESTAMP_MODE: 'secure',
      GENOFFICE_NOTARIZATION_AUTHORIZED: '1',
      APPLE_KEYCHAIN_PROFILE: 'fixture-profile',
    })

    expect(config.mac.notarize).toBe(true)
  })

  it('normalizes an approved HTTPS update channel without embedding credentials', () => {
    const config = createBuilderConfig({
      GENOFFICE_UPDATE_URL: 'https://updates.example.com/codexoffice///',
    })

    expect(config.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://updates.example.com/codexoffice',
        channel: 'latest',
      },
    ])
  })

  it.each([
    'http://updates.example.com/codexoffice',
    'https://user:secret@updates.example.com/codexoffice',
    'https://updates.example.com/codexoffice?token=secret',
    'https://updates.example.com/codexoffice#latest',
    ' https://updates.example.com/codexoffice',
    'not-a-url',
  ])('rejects an unsafe update channel before packaging: %s', (updateUrl) => {
    expect(() => createBuilderConfig({ GENOFFICE_UPDATE_URL: updateUrl })).toThrow(
      '[update] invalid update channel URL',
    )
  })
})

describe('Codex packaging runtime targets', () => {
  it.each([
    ['arm64', '@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    ['x64', '@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  ])('resolves the approved darwin-%s runtime contract', (architecture, packageName, triple) => {
    expect(codexRuntimeModule.resolveCodexBuildRuntimeForTarget).toBeTypeOf('function')

    expect(
      codexRuntimeModule.resolveCodexBuildRuntimeForTarget!(
        'darwin',
        architecture,
        runtimeDependencies('darwin', architecture),
      ),
    ).toEqual({
      packageName,
      vendorSource: join('/fixture', 'node_modules', packageName, 'vendor'),
      executable: join('/fixture', 'node_modules', packageName, 'vendor', triple, 'bin', 'codex'),
    })
  })

  it('keeps linux-x64 explicitly unsupported without consulting runtime files', () => {
    const dependencies = {
      repoRoot: '/fixture',
      exists: vi.fn(),
      readFile: vi.fn(),
      stat: vi.fn(),
    }

    expect(() =>
      codexRuntimeModule.resolveCodexBuildRuntimeForTarget!('linux', 'x64', dependencies),
    ).toThrow('Unsupported Codex packaging target: linux-x64')
    expect(dependencies.exists).not.toHaveBeenCalled()
    expect(dependencies.readFile).not.toHaveBeenCalled()
    expect(dependencies.stat).not.toHaveBeenCalled()
  })

  it('keeps the production wrapper equivalent to an explicit supported target', () => {
    const dependencies = runtimeDependencies('darwin', 'arm64')
    const explicit = codexRuntimeModule.resolveCodexBuildRuntimeForTarget!(
      'darwin',
      'arm64',
      dependencies,
    )

    expect(
      codexRuntimeModule.resolveCodexBuildRuntime!({
        argv: [],
        lifecycle: '',
        platform: 'darwin',
        architecture: 'arm64',
        runtimeDependencies: dependencies,
      }),
    ).toEqual(explicit)
  })
})

describe('release identity receipt', () => {
  const sourceSha = '0123456789abcdef0123456789abcdef01234567'
  const staleSha = 'fedcba9876543210fedcba9876543210fedcba98'
  const appAsarSha256 = '7d39080393f92ef93be590e41f3dc382a37cd4f7c0be9688fe8f76f318304c1d'
  let root = ''
  let appPath = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codexoffice-release-identity-'))
    appPath = join(root, 'Codexoffice.app')
    mkdirSync(join(appPath, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(join(appPath, 'Contents', 'Resources', 'app.asar'), 'fixture-app-asar-v1')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes and verifies a non-sensitive source and payload receipt', () => {
    expect(releaseIdentityModule.createReleaseIdentity).toBeTypeOf('function')
    const releaseIdentity = releaseIdentityModule.createReleaseIdentity!({
      env: { GENOFFICE_SOURCE_SHA: sourceSha },
      resolveHead: () => sourceSha,
      resolveStatus: () => '',
    })

    const receipt = releaseIdentity.writeReceipt(appPath, {
      productName: 'Codexoffice',
      appId: 'com.genoffice.app',
      version: '0.5.0',
    })

    expect(receipt).toEqual({
      schemaVersion: 1,
      productName: 'Codexoffice',
      appId: 'com.genoffice.app',
      version: '0.5.0',
      sourceSha,
      packagePayload: {
        path: 'Contents/Resources/app.asar',
        sha256: appAsarSha256,
      },
    })
    expect(
      JSON.parse(
        readFileSync(join(appPath, 'Contents', 'Resources', 'release-identity.json'), 'utf8'),
      ),
    ).toEqual(receipt)
    expect(releaseIdentity.verifyReceipt(appPath, sourceSha)).toEqual(receipt)
  })

  it('rejects a declared source SHA that does not match Git HEAD before writing', () => {
    const releaseIdentity = releaseIdentityModule.createReleaseIdentity!({
      env: { GENOFFICE_SOURCE_SHA: sourceSha },
      resolveHead: () => staleSha,
      resolveStatus: () => '',
    })

    expect(() =>
      releaseIdentity.writeReceipt(appPath, {
        productName: 'Codexoffice',
        appId: 'com.genoffice.app',
        version: '0.5.0',
      }),
    ).toThrow('source SHA mismatch')
    expect(existsSync(join(appPath, 'Contents', 'Resources', 'release-identity.json'))).toBe(false)
  })

  it('rejects stale expected SHA and modified packaged payload bytes', () => {
    const releaseIdentity = releaseIdentityModule.createReleaseIdentity!({
      env: { GENOFFICE_SOURCE_SHA: sourceSha },
      resolveHead: () => sourceSha,
      resolveStatus: () => '',
    })
    releaseIdentity.writeReceipt(appPath, {
      productName: 'Codexoffice',
      appId: 'com.genoffice.app',
      version: '0.5.0',
    })

    expect(() => releaseIdentity.verifyReceipt(appPath, staleSha)).toThrow('source SHA mismatch')
    writeFileSync(join(appPath, 'Contents', 'Resources', 'app.asar'), 'tampered')
    expect(() => releaseIdentity.verifyReceipt(appPath, sourceSha)).toThrow(
      'package payload digest mismatch',
    )
  })

  it('verifies identical source and app.asar payload across builder ZIP and DMG surfaces', () => {
    const releaseIdentity = releaseIdentityModule.createReleaseIdentity!({
      env: { GENOFFICE_SOURCE_SHA: sourceSha },
      resolveHead: () => sourceSha,
      resolveStatus: () => '',
    })
    releaseIdentity.writeReceipt(appPath, {
      productName: 'Codexoffice',
      appId: 'com.genoffice.app',
      version: '0.5.0',
    })
    const zipApp = join(root, 'zip', 'Codexoffice.app')
    const dmgApp = join(root, 'dmg', 'Codexoffice.app')
    cpSync(appPath, zipApp, { recursive: true })
    cpSync(appPath, dmgApp, { recursive: true })

    const receipts = [appPath, zipApp, dmgApp].map((surface) =>
      releaseIdentity.verifyReceipt(surface, sourceSha),
    )
    expect(receipts).toEqual([receipts[0], receipts[0], receipts[0]])
  })

  it('rejects a dirty tracked or untracked source before writing a release receipt', () => {
    const releaseIdentity = releaseIdentityModule.createReleaseIdentity!({
      env: { GENOFFICE_SOURCE_SHA: sourceSha },
      resolveHead: () => sourceSha,
      resolveStatus: () => ' M apps/shell/src/main/index.ts\n?? untracked-release-input',
    })

    expect(() =>
      releaseIdentity.writeReceipt(appPath, {
        productName: 'Codexoffice',
        appId: 'com.genoffice.app',
        version: '0.5.0',
      }),
    ).toThrow('worktree is dirty')
    expect(existsSync(join(appPath, 'Contents', 'Resources', 'release-identity.json'))).toBe(false)
  })
})
