import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient, codexImageAppServerArgs, resolveCodexExecutable } from '../src/node'

function fakeAppServer(
  options: {
    closeOnSigterm?: boolean
    closeOnSigkill?: boolean
    initializeNotifications?: string[]
  } = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    kill(signal?: NodeJS.Signals): boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  const kill = vi.fn((signal?: NodeJS.Signals): boolean => {
    child.killed = true
    if (
      (signal === 'SIGKILL' && options.closeOnSigkill !== false) ||
      (signal !== 'SIGKILL' && options.closeOnSigterm !== false)
    ) {
      queueMicrotask(() => child.emit('close'))
    }
    return true
  })
  child.kill = kill

  let pending = ''
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      const message = JSON.parse(line) as { id?: number; method: string }
      if (message.method === 'initialize') {
        for (const method of options.initializeNotifications ?? []) {
          child.stdout.write(`${JSON.stringify({ method, params: {} })}\n`)
        }
        child.stdout.write(
          `${JSON.stringify({
            method: 'remoteControl/status/changed',
            params: { status: 'disabled', serverName: 'local', installationId: 'test' },
          })}\n`,
        )
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`)
      } else if (message.method === 'account/read') {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { account: { type: 'chatgpt' } } })}\n`,
        )
      }
      newline = pending.indexOf('\n')
    }
  })
  queueMicrotask(() => child.emit('spawn'))
  return { child, kill }
}

describe('Codex App Server transport', () => {
  it('tolerates the disabled remote-control status emitted by exact Codex 0.146', async () => {
    const { child, kill } = fakeAppServer()
    const client = new CodexAppServerClient({
      executable: '/trusted/codex-0.146',
      args: ['app-server'],
      cwd: '/private/tmp/codexoffice-test',
      env: {},
      spawnProcess: () => child,
    })

    await client.start()
    await expect(client.request('account/read', { refreshToken: false })).resolves.toEqual({
      account: { type: 'chatgpt' },
    })
    await client.stop()
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('allows passive image-turn notifications from the exact 0.146 schema', async () => {
    const notifications = [
      'item/reasoning/textDelta',
      'rawResponseItem/completed',
      'rawResponse/completed',
      'turn/moderationMetadata',
      'model/safetyBuffering/updated',
      'guardianWarning',
    ]
    const { child } = fakeAppServer({ initializeNotifications: notifications })
    const client = new CodexAppServerClient({
      executable: '/trusted/codex-0.146',
      args: ['app-server'],
      cwd: '/private/tmp/codexoffice-test',
      env: {},
      spawnProcess: () => child,
    })
    const seen: string[] = []
    client.onNotification((notification) => seen.push(notification.method))

    await client.start()
    await expect(client.request('account/read', { refreshToken: false })).resolves.toEqual({
      account: { type: 'chatgpt' },
    })
    expect(seen).toEqual([...notifications, 'remoteControl/status/changed'])
    await client.stop()
  })

  it('starts the exact bundled Codex binary with the strict image configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexoffice-image-config-'))
    const env: Record<string, string> = { CODEX_HOME: directory }
    for (const key of [
      'HOME',
      'USER',
      'LOGNAME',
      'PATH',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'LC_ALL',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
      'SystemRoot',
      'WINDIR',
    ]) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    const client = new CodexAppServerClient({
      executable: resolveCodexExecutable(),
      args: codexImageAppServerArgs(),
      cwd: directory,
      env,
    })

    try {
      await client.start()
    } finally {
      await client.stop().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('escalates to SIGKILL when SIGTERM does not close the child', async () => {
    const { child, kill } = fakeAppServer({ closeOnSigterm: false })
    const client = new CodexAppServerClient({
      executable: '/trusted/codex-0.146',
      args: ['app-server'],
      cwd: '/private/tmp/codexoffice-test',
      env: {},
      stopTimeoutMs: 5,
      spawnProcess: () => child,
    })

    await client.start()
    await client.stop()
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('does not resolve stop until the child closes after SIGKILL', async () => {
    const { child, kill } = fakeAppServer({ closeOnSigterm: false, closeOnSigkill: false })
    const client = new CodexAppServerClient({
      executable: '/trusted/codex-0.146',
      args: ['app-server'],
      cwd: '/private/tmp/codexoffice-test',
      env: {},
      stopTimeoutMs: 100,
      spawnProcess: () => child,
    })

    await client.start()
    let stopped = false
    const stopping = client.stop().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGKILL'))
    expect(stopped).toBe(false)
    child.emit('close')
    await stopping
    expect(stopped).toBe(true)
  })

  it('handles forced-stop failure after a protocol error without an unhandled rejection', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { child } = fakeAppServer({
      closeOnSigterm: false,
      closeOnSigkill: false,
      initializeNotifications: ['unknown/notification'],
    })
    const client = new CodexAppServerClient({
      executable: '/trusted/codex-0.146',
      args: ['app-server'],
      cwd: '/private/tmp/codexoffice-test',
      env: {},
      stopTimeoutMs: 5,
      spawnProcess: () => child,
    })

    await expect(client.start()).rejects.toThrow('invalid protocol response')
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        'Codex image App Server cleanup failed',
        expect.objectContaining({ code: 'CODEX_IMAGE_PROCESS_CLEANUP_FAILED' }),
      ),
    )
    warning.mockRestore()
  })
})
