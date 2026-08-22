import { randomUUID } from 'node:crypto'

export interface ThemeImportToken<TSession extends object, TCandidate> {
  token: string
  session: TSession
  expiresAt: number
  candidates: TCandidate[]
}

/** Per-renderer, session-bound, expiring, single-use capability store. */
export class ThemeImportTokenStore<TSession extends object, TCandidate> {
  private readonly pending = new Map<number, ThemeImportToken<TSession, TCandidate>>()

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now = () => Date.now(),
  ) {}

  create(webContentsId: number, session: TSession, candidates: TCandidate[]) {
    const value = { token: randomUUID(), session, expiresAt: this.now() + this.ttlMs, candidates }
    this.pending.set(webContentsId, value)
    return value
  }

  invalidate(webContentsId: number): void {
    this.pending.delete(webContentsId)
  }

  consume(webContentsId: number, token: string, session: TSession) {
    const value = this.pending.get(webContentsId)
    this.pending.delete(webContentsId)
    if (
      !value ||
      value.token !== token ||
      value.session !== session ||
      value.expiresAt <= this.now()
    )
      return null
    return value
  }
}
