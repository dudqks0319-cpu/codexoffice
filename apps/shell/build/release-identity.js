const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const RECEIPT_NAME = 'release-identity.json'
const PAYLOAD_PATH = 'Contents/Resources/app.asar'
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/

function createReleaseIdentity(dependencies = {}) {
  const environment = dependencies.env ?? process.env
  const repositoryRoot = dependencies.repositoryRoot ?? resolve(__dirname, '../../..')
  const resolveHead =
    dependencies.resolveHead ??
    (() =>
      execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim())
  const resolveStatus =
    dependencies.resolveStatus ??
    (() =>
      execFileSync('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim())

  function normalizedSha(value, label) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!SOURCE_SHA_PATTERN.test(normalized)) {
      throw new Error(`[release-identity] invalid ${label}`)
    }
    return normalized
  }

  function payloadDigest(appPath) {
    return createHash('sha256').update(readFileSync(join(appPath, PAYLOAD_PATH))).digest('hex')
  }

  function receiptPath(appPath) {
    return join(appPath, 'Contents', 'Resources', RECEIPT_NAME)
  }

  function sourceSha() {
    if (resolveStatus() !== '') throw new Error('[release-identity] worktree is dirty')
    const head = normalizedSha(resolveHead(), 'Git HEAD')
    const declared = environment.GENOFFICE_SOURCE_SHA
      ? normalizedSha(environment.GENOFFICE_SOURCE_SHA, 'declared source SHA')
      : head
    if (declared !== head) throw new Error('[release-identity] source SHA mismatch')
    return head
  }

  function writeReceipt(appPath, metadata) {
    const receipt = {
      schemaVersion: 1,
      productName: metadata.productName,
      appId: metadata.appId,
      version: metadata.version,
      sourceSha: sourceSha(),
      packagePayload: {
        path: PAYLOAD_PATH,
        sha256: payloadDigest(appPath),
      },
    }
    const destination = receiptPath(appPath)
    const temporary = `${destination}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 })
    renameSync(temporary, destination)
    return receipt
  }

  function verifyReceipt(appPath, expectedSourceSha) {
    const receipt = JSON.parse(readFileSync(receiptPath(appPath), 'utf8'))
    const expected = normalizedSha(expectedSourceSha, 'expected source SHA')
    const recorded = normalizedSha(receipt.sourceSha, 'receipt source SHA')
    if (recorded !== expected) throw new Error('[release-identity] source SHA mismatch')
    if (
      receipt.schemaVersion !== 1 ||
      receipt.packagePayload?.path !== PAYLOAD_PATH ||
      receipt.packagePayload?.sha256 !== payloadDigest(appPath)
    ) {
      throw new Error('[release-identity] package payload digest mismatch')
    }
    return receipt
  }

  return { writeReceipt, verifyReceipt }
}

function writeReleaseIdentity(context) {
  if (context.electronPlatformName && context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  const releaseIdentity = createReleaseIdentity()
  releaseIdentity.writeReceipt(appPath, {
    productName: appName,
    appId: context.packager.appInfo.id ?? 'com.genoffice.app',
    version: context.packager.appInfo.version,
  })
}

exports.createReleaseIdentity = createReleaseIdentity
exports.default = writeReleaseIdentity
