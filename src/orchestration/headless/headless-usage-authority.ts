import { createUsageAuthority, type UsageAuthority } from "../../infra/llm/usage-authority.js"
import type { UsageSettlementAuthorityLease } from "../agent-runtime/usage-settlement.js"

interface HeadlessUsageProfile {
  readonly id: string
  readonly directory: string
}

export interface HeadlessUsageAuthorityOwner {
  acquire(profile: { readonly profileId: string; readonly profileDir: string }): Promise<UsageSettlementAuthorityLease>
  generation(): { readonly profileId: string; readonly authorityIncarnation: string }
  assertGeneration(expected: { readonly profileId: string; readonly authorityIncarnation: string }): void
  settled(): Promise<void>
}

/** Owns the exact profile Usage authority for one finite headless execution. New settlement leases are rejected once shutdown starts, and shutdown waits for admitted publications before closing SQLite. */
export function createHeadlessUsageAuthorityOwner(profile: HeadlessUsageProfile): HeadlessUsageAuthorityOwner {
  let authority: UsageAuthority | undefined
  let leases = 0
  let closing = false
  let wake: (() => void) | undefined
  let settlement: Promise<void> | undefined

  const acquire = async (requested: { readonly profileId: string; readonly profileDir: string }): Promise<UsageSettlementAuthorityLease> => {
    if (closing) throw new Error("headless Usage authority admission is closed")
    if (requested.profileId !== profile.id || requested.profileDir !== profile.directory) {
      throw new Error(`Usage settlement profile mismatch: expected ${profile.id}`)
    }
    let admitted = authority
    if (admitted === undefined) {
      admitted = createUsageAuthority({ profileDir: profile.directory, profileId: profile.id })
      authority = admitted
    }
    leases += 1
    let released = false
    return {
      profileId: admitted.profileId,
      authorityIncarnation: admitted.incarnation(),
      append: (entry) => {
        if (released) throw new Error("headless Usage authority lease is released")
        return admitted.append(entry)
      },
      release: async () => {
        if (released) return
        released = true
        leases -= 1
        if (leases === 0) {
          wake?.()
          wake = undefined
        }
      },
    }
  }

  const settled = (): Promise<void> => {
    if (settlement !== undefined) return settlement
    settlement = (async () => {
      closing = true
      if (leases > 0) await new Promise<void>((resolve) => { wake = resolve })
      authority?.dispose()
      authority = undefined
    })()
    return settlement
  }

  const generation = () => {
    const current = authority
    if (current === undefined) throw new Error("headless Usage authority is not acquired")
    return { profileId: current.profileId, authorityIncarnation: current.incarnation() }
  }
  const assertGeneration = (expected: { readonly profileId: string; readonly authorityIncarnation: string }): void => {
    const current = generation()
    if (current.profileId !== expected.profileId || current.authorityIncarnation !== expected.authorityIncarnation) {
      throw new Error("headless Usage authority identity does not match")
    }
  }

  return { acquire, generation, assertGeneration, settled }
}
