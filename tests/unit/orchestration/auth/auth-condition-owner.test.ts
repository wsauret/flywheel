import { describe, expect, spyOn, test } from "bun:test"
import { decodeAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js"
import { Log } from "../../../../src/infra/log.js"
import { createAuthConditionOwner } from "../../../../src/orchestration/auth/auth-condition-owner.js"

const directory = "/profiles/default"
const path = `${directory}/auth.json`

describe("auth condition owner", () => {
  test("merges only current-revision mutations and replaces transients on a changed observation", () => {
    let observations = 0
    const owner = createAuthConditionOwner(() => { observations++ })
    const file = { kind: "malformed", scope: "file", authDirectory: directory, path, revision: "r1" } as const
    const provider = { kind: "malformed", scope: "provider", providerId: "anthropic_api", authDirectory: directory, revision: "r1" } as const
    const stale = { ...provider, providerId: "openai_api", revision: "r0" } as const
    const refused = { kind: "refused", category: "oversized", scope: "file", authDirectory: directory, path } as const

    const load = { revision: "r1", store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions: [file] }
    owner.observeLoad(directory, load)
    owner.observeMutation([provider, stale, refused, refused])
    expect(owner.snapshot(directory)).toEqual([file, provider, refused])
    expect(observations).toBe(1)

    expect(owner.observeLoad(directory, load)).toBe(false)
    expect(owner.snapshot(directory)).toEqual([file, provider, refused])
    owner.observeLoad(directory, { ...load, revision: "r2", conditions: [{ ...file, revision: "r2" }] })
    owner.observeMutation([provider])
    expect(owner.snapshot(directory)).toEqual([{ ...file, revision: "r2" }])
    expect(observations).toBe(1)
  })

  test("admits a refusal for the exact revision of a healthy load", () => {
    const owner = createAuthConditionOwner()
    const provider = { kind: "malformed", scope: "provider", providerId: "openai_api", authDirectory: directory, revision: "healthy" } as const
    owner.observeLoad(directory, { revision: "healthy", store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions: [] })
    owner.observeMutation([provider])
    expect(owner.snapshot(directory)).toEqual([provider])
    owner.remove(directory)
    expect(owner.snapshot(directory)).toEqual([])
  })

  test("reports legacy resets once per complete observation and reports them again after repair", () => {
    const owner = createAuthConditionOwner()
    const warnings = spyOn(Log.create({ service: "auth-store" }), "warn").mockImplementation(() => {})
    const legacy = { ...decodeAuthStoreWithDiagnostics({ chatgpt: [{ id: "legacy", identity: "legacy", credential: { type: "oauth", access: "old", expires: 1 } }] }, { report: false }), revision: "legacy" }
    try {
      for (let i = 0; i < 3; i++) owner.observeLoad(directory, legacy)
      expect(warnings).toHaveBeenCalledTimes(1)
      expect(warnings).toHaveBeenCalledWith("legacy subscription credential reset: reauthentication required", { provider: "chatgpt" })
      expect(legacy.store.chatgpt).toEqual([])
      owner.observeLoad(directory, { ...legacy, revision: "repaired", legacyResetProviders: [] })
      owner.observeLoad(directory, legacy)
      expect(warnings).toHaveBeenCalledTimes(2)
    } finally {
      warnings.mockRestore()
    }
  })
})
