/** A Univer undo resolves false when no pre-image was restored. Treat that as
 * a recovery failure, not as a successful rollback. */
export async function requireSuccessfulUndo(undo: () => Promise<boolean>): Promise<void> {
  const restored = await undo()
  if (!restored) throw new Error('Undo returned false.')
}
