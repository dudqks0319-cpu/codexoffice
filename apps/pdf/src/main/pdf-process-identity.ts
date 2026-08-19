import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PdfProcessIdentityResult =
  | { readonly state: 'alive'; readonly identity: string }
  | { readonly state: 'dead' }
  | { readonly state: 'unknown' }

export type PdfProcessIdentityLookup = (pid: number) => PdfProcessIdentityResult

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'dead'
    if (errorCode(error) === 'EPERM') return 'alive'
    return 'unknown'
  }
}

function readDarwinIdentity(pid: number): string | undefined {
  const startedAt = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .trim()
    .replace(/\s+/g, ' ')
  if (!startedAt || startedAt.length > 128) return undefined
  const epochSeconds = Math.floor(Date.parse(startedAt) / 1_000)
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) return undefined
  return `darwin:${epochSeconds}`
}

function readLinuxIdentity(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) return undefined
  // The first token after the command is field 3. Process start time is field 22.
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const startTicks = fields[19]
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!startTicks || !/^\d+$/.test(startTicks) || !/^[0-9a-f-]{16,64}$/i.test(bootId)) {
    return undefined
  }
  return `linux:${bootId}:${startTicks}`
}

function readWindowsIdentity(pid: number): string | undefined {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) return undefined
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const startedAtTicks = execFileSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeSeconds()`,
    ],
    {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim()
  if (!/^\d{9,12}$/.test(startedAtTicks)) return undefined
  return `win32:${startedAtTicks}`
}

let cachedCurrentProcessIdentity: string | undefined

/**
 * Resolve an OS process generation, not only a PID. PID reuse can otherwise
 * make a crashed PDF commit look active forever and hide the canonical source.
 */
export const lookupPdfProcessIdentity: PdfProcessIdentityLookup = (pid) => {
  const liveness = processLiveness(pid)
  if (liveness !== 'alive') return { state: liveness }
  if (pid === process.pid && cachedCurrentProcessIdentity) {
    return { state: 'alive', identity: cachedCurrentProcessIdentity }
  }
  if (pid === process.pid && (process.platform === 'darwin' || process.platform === 'win32')) {
    const epochSeconds = Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)
    if (Number.isSafeInteger(epochSeconds) && epochSeconds > 0) {
      cachedCurrentProcessIdentity = `${process.platform}:${epochSeconds}`
      return { state: 'alive', identity: cachedCurrentProcessIdentity }
    }
  }
  try {
    const identity =
      process.platform === 'darwin'
        ? readDarwinIdentity(pid)
        : process.platform === 'linux'
          ? readLinuxIdentity(pid)
          : process.platform === 'win32'
            ? readWindowsIdentity(pid)
            : undefined
    if (!identity) return { state: 'unknown' }
    if (pid === process.pid) cachedCurrentProcessIdentity = identity
    return { state: 'alive', identity }
  } catch (error) {
    // The process may have exited between the liveness check and identity read.
    if (errorCode(error) === 'ESRCH' || errorCode(error) === 'ENOENT') {
      return processLiveness(pid) === 'dead' ? { state: 'dead' } : { state: 'unknown' }
    }
    return { state: 'unknown' }
  }
}
