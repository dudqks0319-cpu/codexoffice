import { describe, expect, it, vi } from 'vitest'
import { createBlankPptx, openPptx, parseTheme, savePptx } from '@genoffice/pptx-engine'
import type { Session } from '../src/main/session-state'
import {
  beginHistoryBatch,
  carryHistoryForReplacement,
  endHistoryBatch,
  pushHistory,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  markHistoryDirtyAfterSave,
  applyThemeToSession,
  sessionRevision,
  takeSnapshot,
  sessionIsCurrent,
  sessions,
  bumpSessionRevision,
} from '../src/main/session-state'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
}))
vi.mock('../src/main/fonts', () => ({
  createSystemFontMetrics: () => ({
    metrics: ({ fontSizePx }: { fontSizePx: number }) => ({
      ascent: fontSizePx * 0.8,
      descent: fontSizePx * 0.2,
      lineHeight: fontSizePx * 1.2,
    }),
    measure: (text: string, { fontSizePx }: { fontSizePx: number }) =>
      text.length * fontSizePx * 0.5,
  }),
}))

function sessionWith(value: string): Session {
  return {
    path: '',
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
    opened: {
      deck: {
        slides: [{ value }],
        size: { cx: 1, cy: 1 },
      },
      archive: { entries: new Map([['deck', new Uint8Array([value.length])]]) },
    },
  } as unknown as Session
}

function valueOf(session: Session): string {
  return (session.opened.deck.slides[0] as unknown as { value: string }).value
}

function setValue(session: Session, value: string): void {
  ;(session.opened.deck.slides[0] as unknown as { value: string }).value = value
}

describe('Slides main-process history batching', () => {
  it('collapses several edits into one pre-run snapshot', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'first')
    pushHistory(session)
    setValue(session, 'second')
    endHistoryBatch(session)

    expect(session.undoStack).toHaveLength(1)
    restoreSnapshot(session, session.undoStack[0]!)
    expect(valueOf(session)).toBe('before')
  })

  it('supports nested tool batching inside an AI-run batch', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'after')
    endHistoryBatch(session)
    expect(session.historyBatch?.depth).toBe(1)
    endHistoryBatch(session)
    expect(session.undoStack).toHaveLength(1)
  })

  it('does not create a history step when every edit is rolled back', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    session.undoStack.pop()
    endHistoryBatch(session)
    expect(session.undoStack).toHaveLength(0)
  })

  it('restores the deck size on undo', () => {
    const session = sessionWith('before')
    pushHistory(session)
    session.opened.deck.size = { cx: 2, cy: 3 }
    setValue(session, 'after')

    restoreSnapshot(session, session.undoStack.pop()!)
    expect(session.opened.deck.size).toEqual({ cx: 1, cy: 1 })
    expect(valueOf(session)).toBe('before')
  })

  it('restores metadata-only dirty state and marks pre-save snapshots dirty', () => {
    const session = sessionWith('before')
    session.metaDirty = false
    pushHistory(session)
    session.metaDirty = true
    restoreSnapshot(session, session.undoStack[0]!)
    expect(session.metaDirty).toBe(false)

    pushHistory(session)
    markHistoryDirtyAfterSave(session)
    expect(session.undoStack.every((snapshot) => snapshot.metaDirty)).toBe(true)
  })

  it('keeps the old deck snapshot when replacing the full deck', () => {
    const previous = sessionWith('old deck')
    const replacement = sessionWith('new deck')
    carryHistoryForReplacement(previous, replacement)

    expect(replacement.undoStack).toHaveLength(1)
    restoreSnapshot(replacement, replacement.undoStack.pop()!)
    expect(valueOf(replacement)).toBe('old deck')
  })

  it('returns the pre-run snapshot from the outermost batch end with edits', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'after')
    expect(endHistoryBatch(session)).toBeNull()
    const before = endHistoryBatch(session)
    expect(before).not.toBeNull()
    expect((before!.slides[0] as unknown as { value: string }).value).toBe('before')

    const emptyRun = sessionWith('untouched')
    beginHistoryBatch(emptyRun)
    expect(endHistoryBatch(emptyRun)).toBeNull()
  })

  it('rolls back to a registered AI snapshot and makes the rollback undoable', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    const id = registerAiSnapshot(session, endHistoryBatch(session)!)

    setValue(session, 'user edited on top')
    expect(restoreAiSnapshot(session, id)).toBe(true)
    expect(valueOf(session)).toBe('before')
    expect(restoreAiSnapshot(session, id)).toBe(false) // consumed

    restoreSnapshot(session, session.undoStack.pop()!) // ⌘Z returns to the pre-rollback state
    expect(valueOf(session)).toBe('user edited on top')
  })

  it('keeps registered snapshots isolated from later in-place deck mutations', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    const id = registerAiSnapshot(session, endHistoryBatch(session)!)

    restoreSnapshot(session, session.undoStack.pop()!) // undo hands the stack snapshot to the live deck
    setValue(session, 'mutated after undo')
    expect(restoreAiSnapshot(session, id)).toBe(true)
    expect(valueOf(session)).toBe('before')
  })

  it('undo → edit → redo replays the state that was undone, not a mutated copy', () => {
    const session = sessionWith('before')
    pushHistory(session)
    setValue(session, 'edited')

    // ⌘Z
    session.redoStack.push({
      slides: structuredClone(session.opened.deck.slides),
      entries: new Map(session.opened.archive.entries),
      size: { ...session.opened.deck.size },
      metaDirty: !!session.metaDirty,
    })
    restoreSnapshot(session, session.undoStack.pop()!)
    expect(valueOf(session)).toBe('before')

    // typing after the undo must not rewrite the redo snapshot in place
    setValue(session, 'typed after undo')
    restoreSnapshot(session, session.redoStack.pop()!)
    expect(valueOf(session)).toBe('edited')
  })

  it('a batch left open by a crashed tool path is collapsed so undo still works', () => {
    const session = sessionWith('before')
    // run begins a batch, a tool nests another, then the tool path dies without ending either
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    beginHistoryBatch(session)
    expect(session.historyBatch).toBeDefined()

    settleStaleHistoryBatch(session)
    expect(session.historyBatch).toBeUndefined()
    expect(session.undoStack.length).toBe(1)

    restoreSnapshot(session, session.undoStack.pop()!)
    expect(valueOf(session)).toBe('before')
  })

  it('increments a monotonic revision so an edit that lands during save stays detectable', () => {
    const session = sessionWith('before')
    const saveRevision = sessionRevision(session)
    pushHistory(session)
    setValue(session, 'edited while save was running')
    expect(sessionRevision(session)).toBeGreaterThan(saveRevision)
  })

  it('keeps detecting mutations after a gesture has already opened its one-step history', () => {
    const session = sessionWith('before')
    pushHistory(session)
    const saveRevision = sessionRevision(session)
    // Later preview/final-commit frames do not push another history entry, but their
    // mutation path calls this same revision bump before save completion.
    bumpSessionRevision(session)
    expect(session.undoStack).toHaveLength(1)
    expect(sessionRevision(session)).toBeGreaterThan(saveRevision)
  })

  it('detects that an async save belongs to a replaced document session', () => {
    const previous = sessionWith('previous')
    const replacement = sessionWith('replacement')
    sessions.set(91, previous)
    expect(sessionIsCurrent(91, previous)).toBe(true)
    sessions.set(91, replacement)
    expect(sessionIsCurrent(91, previous)).toBe(false)
    sessions.delete(91)
  })

  it('restores a full history stack, redo, fit width, HTML state, and revision after theme failure', () => {
    const session = sessionWith('before')
    for (let index = 0; index < 50; index++) {
      pushHistory(session)
      setValue(session, `history-${index}`)
    }
    const undoBefore = session.undoStack.map(
      (snapshot) => (snapshot.slides[0] as unknown as { value: string }).value,
    )
    const redoBefore = [takeSnapshot(session)]
    session.redoStack = redoBefore
    session.htmlPages = ['preserve']
    const fitWidthBefore = session.fitWidthPx
    const revisionBefore = sessionRevision(session)
    const colors = Object.fromEntries(
      [
        'dk1',
        'lt1',
        'dk2',
        'lt2',
        'accent1',
        'accent2',
        'accent3',
        'accent4',
        'accent5',
        'accent6',
        'hlink',
        'folHlink',
      ].map((key) => [key, '#123456']),
    )

    expect(applyThemeToSession(session, { name: 'Safe', colors }, 640)).toHaveProperty('error')
    expect(
      session.undoStack.map(
        (snapshot) => (snapshot.slides[0] as unknown as { value: string }).value,
      ),
    ).toEqual(undoBefore)
    expect(session.redoStack).toBe(redoBefore)
    expect(session.htmlPages).toEqual(['preserve'])
    expect(session.fitWidthPx).toBe(fitWidthBefore)
    expect(sessionRevision(session)).toBe(revisionBefore)
  })

  it('applies an imported design as one undo step and preserves it across save/reopen', async () => {
    const opened = await openPptx(await createBlankPptx())
    const session = {
      path: '',
      opened,
      fitWidthPx: 1280,
      undoStack: [],
      redoStack: [],
    } as Session
    const originalTheme = opened.archive.readText('ppt/theme/theme1.xml')!
    const colors = {
      dk1: '#101820',
      lt1: '#FAF7F0',
      dk2: '#334155',
      lt2: '#E5E7EB',
      accent1: '#2563EB',
      accent2: '#EA580C',
      accent3: '#0F766E',
      accent4: '#CA8A04',
      accent5: '#7C3AED',
      accent6: '#DB2777',
      hlink: '#1D4ED8',
      folHlink: '#6D28D9',
    }

    const rendered = applyThemeToSession(
      session,
      {
        name: 'Imported',
        colors,
        majorFont: 'Arial',
        minorFont: 'Arial',
      },
      1280,
    )
    expect(Array.isArray(rendered)).toBe(true)
    expect(session.undoStack).toHaveLength(1)
    const reopened = await openPptx(await savePptx(session.opened))
    expect(parseTheme(reopened.archive.readText('ppt/theme/theme1.xml')!).colors.accent1).toBe(
      '#2563EB',
    )

    restoreSnapshot(session, session.undoStack.pop()!)
    expect(session.opened.archive.readText('ppt/theme/theme1.xml')).toBe(originalTheme)
  })
})
