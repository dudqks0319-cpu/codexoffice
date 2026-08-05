import { describe, expect, it, vi } from 'vitest'
import {
  getCodexAccountStatus,
  loginCodex,
  logoutCodex,
  type CodexAuthDependencies,
} from '../src/codex-auth'

const executable = '/trusted/codex'

describe('Codex account helpers', () => {
  it('maps login status without exposing CLI details', async () => {
    const runCli = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'Logged in using ChatGPT',
      stderr: '',
    })
    await expect(
      getCodexAccountStatus({ resolveExecutable: () => executable, runCli }),
    ).resolves.toEqual({ loggedIn: true, authMethod: 'chatgpt' })
    expect(runCli).toHaveBeenCalledWith(
      executable,
      ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
      expect.any(AbortSignal),
    )
  })

  it('returns logged out for the CLI logged-out status', async () => {
    await expect(
      getCodexAccountStatus({
        resolveExecutable: () => executable,
        runCli: async () => ({ code: 1, stdout: '', stderr: 'Not logged in' }),
      }),
    ).resolves.toEqual({ loggedIn: false })
  })

  it('normalizes auth failures and redacts raw stderr', async () => {
    await expect(
      getCodexAccountStatus({
        resolveExecutable: () => executable,
        runCli: async () => ({
          code: 1,
          stdout: '',
          stderr: '401 token=super-secret-value',
        }),
      }),
    ).rejects.toThrow('Codex status was not authorized')
    await expect(
      getCodexAccountStatus({
        resolveExecutable: () => executable,
        runCli: async () => ({ code: 1, stdout: '', stderr: 'token=super-secret-value' }),
      }),
    ).rejects.not.toThrow('super-secret-value')
  })

  it('allows only one login process at a time', async () => {
    let finishLogin!: (value: { code: number; stdout: string; stderr: string }) => void
    const first = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      finishLogin = resolve
    })
    const runCli = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' })
    const deps: CodexAuthDependencies = { resolveExecutable: () => executable, runCli }
    const login = loginCodex(undefined, deps)
    await expect(loginCodex(undefined, deps)).rejects.toThrow('already in progress')
    expect(runCli).toHaveBeenCalledTimes(1)
    finishLogin({ code: 0, stdout: '', stderr: '' })
    await expect(login).resolves.toEqual({ loggedIn: true, authMethod: 'chatgpt' })
  })

  it('uses fixed command arguments for login and logout', async () => {
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    const deps = { resolveExecutable: () => executable, runCli }
    await loginCodex(undefined, deps)
    await logoutCodex(deps)
    expect(runCli.mock.calls.map((call) => call[1])).toEqual([
      ['-c', 'cli_auth_credentials_store="file"', 'login'],
      ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
      ['-c', 'cli_auth_credentials_store="file"', 'logout'],
    ])
  })

  it('aborts and settles a hanging status subprocess at its fixed timeout', async () => {
    vi.useFakeTimers()
    try {
      let observedSignal: AbortSignal | undefined
      const runCli: NonNullable<CodexAuthDependencies['runCli']> = async (
        _executable,
        _args,
        signal,
      ) => {
        observedSignal = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const status = getCodexAccountStatus({ resolveExecutable: () => executable, runCli })
      const settled = status.then(
        () => undefined,
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await settled).toEqual(expect.objectContaining({ message: 'Codex status failed' }))
      expect(observedSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
