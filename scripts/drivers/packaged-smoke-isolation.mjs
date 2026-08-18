/**
 * Packaged production builds intentionally ignore launcher-controlled userData
 * overrides so the durable AI ledger cannot be reset. Until a separately
 * identified smoke build owns a compile-time scratch-profile contract,
 * packaged AI smoke drivers must stop before spawn.
 */
export function assertPackagedSmokeIsolation() {
  throw new Error(
    'Packaged AI smoke is disabled: no compile-time scratch-profile contract is configured.',
  )
}
