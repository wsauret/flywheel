import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { authDir } from "../../../../src/infra/paths.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(environmentSelector?: string) {
  const root = mkdtempSync(join(tmpdir(), "auth-admission-read-"))
  roots.push(root)
  const projectRoot = join(root, "project")
  const store = new AuthProfileStore(root)
  for (const id of ["work", "personal"]) (await store.create(id, id === "work" ? "Work" : "Personal")).close()
  await store.withOperation((operation) => operation.writeStickyProfile("work"))
  let binding: string | undefined
  const profiles = new AuthProfileManager({
    userDataRoot: root, projectRoot, store,
    env: environmentSelector === undefined ? {} : { FLYWHEEL_AUTH_PROFILE: environmentSelector },
    config: () => ({ auth: { project_profiles: binding === undefined ? {} : { [projectRoot]: binding } } }),
  })
  const sessions = new Map<string, { readonly kind: "chat"; readonly authProfileId?: string }>([["pinned", { kind: "chat", authProfileId: "work" }], ["legacy", { kind: "chat" }]])
  const prepared: string[] = []
  const admission = createSessionAuthAdmission({
    materialize: async () => { throw new Error("unexpected retirement") },
    manager: {
      read: async (id) => sessions.get(id) ?? null,
      captureAuthProfileIfAbsent: async (id, authProfileId) => { sessions.set(id, { kind: "chat", authProfileId }); return true },
    },
    authProfiles: profiles,
    prepare: async (profileId) => { prepared.push(profileId); return { profileId } },
  })
  return { root, store, profiles, admission, prepared, bind: (id: string) => { binding = id } }
}

describe("session profile admission reads", () => {
  test("admits a warm session while an unrelated profile mutation owns the lock", async () => {
    const { store, admission, prepared } = await fixture()
    await admission.admit("pinned")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutation = store.withOperation(async () => { entered.resolve(); await release.promise })
    await entered.promise
    try {
      const admitted = await Promise.race([
        admission.admit("pinned"),
        Bun.sleep(20).then(() => { throw new Error("admission waited behind the profile mutation lock") }),
      ])
      expect(admitted.workflowDeps.profileId).toBe("work")
      expect(prepared).toEqual(["work"])
    } finally {
      release.resolve()
      await mutation
      await admission.dispose()
    }
  })

  test("reads external sticky publications and current config before default and legacy capture", async () => {
    const { root, admission, bind } = await fixture()
    expect((await admission.admitDefaults()).profile.effectiveId).toBe("work")
    writeFileSync(join(root, "auth", ".active-profile"), "personal")
    expect((await admission.admitDefaults()).profile.effectiveId).toBe("personal")
    bind("work")
    expect((await admission.admit("legacy")).profile.persistedId).toBe("work")
    await admission.dispose()
  })

  test("rejects an externally removed profile despite cached preparation", async () => {
    const { root, admission } = await fixture()
    await admission.admit("pinned")
    rmSync(authDir(root, "work"), { recursive: true })
    await expect(admission.admit("pinned")).rejects.toThrow("auth profile does not exist: work")
    await admission.dispose()
  })

  test("rechecks external descriptor edits for an environment display-name selector", async () => {
    const { root, admission } = await fixture("Work")
    expect((await admission.admit("pinned")).profile.effectiveId).toBe("work")
    writeFileSync(join(authDir(root, "work"), "profile.json"), JSON.stringify({ displayName: "Renamed" }))
    await expect(admission.admit("pinned")).rejects.toThrow("auth profile does not exist: Work")
    await admission.dispose()
  })
})
