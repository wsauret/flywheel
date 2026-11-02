import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js"
import { withProjectRuntime } from "./_project-runtime.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// Short on purpose: the runtime binds a unix socket under this account home,
// and a socket path is bounded (104 bytes on macOS).
const root = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-model-pref-"))

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

async function waitFor<T>(what: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const value = await read()
      if (matches(value)) return value
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

describe("provider-model preferences through the account service runtime", () => {
  test("publishes profile-bound eligibility and rejects a stale dispatched mutation before persistence", async () => {
    const projectRoot = path.join(root, "project")
    const accountHome = path.join(root, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    fs.mkdirSync(userDataRoot, { recursive: true })
    const profiles = new AuthProfileStore(userDataRoot)
    await profiles.withOperation((operation) => { operation.create("default").close() })

    await withProjectRuntime({ executionCwd: projectRoot, projectRoot, accountHome, userDataRoot }, async (client) => {
      const target = { kind: "singleton", providerId: "openai_api" } as const
      const view = await client.query({ type: "provider_models.query", profileId: "default", target })
      expect(view.profileId).toBe("default")
      expect(view.eligibilityRevision).toBeGreaterThan(0)

      let rejection: unknown
      try {
        await client.dispatch({
          type: "provider_model.set",
          queriedProfileId: "another-profile",
          queriedEligibilityRevision: view.eligibilityRevision,
          target,
          modelId: "gpt-5",
          checked: false,
        })
      } catch (error) {
        rejection = error
      }
      expect(String(rejection)).toContain("stale")
      expect(fs.existsSync(path.join(userDataRoot, "auth", "profiles", "default", "model-preferences.json"))).toBe(false)
    })
  }, 60_000)
  test("alternates profile-keyed snapshots and keeps eligibility updates local to each profile", async () => {
    const projectRoot = path.join(root, "profile-keyed-project")
    const accountHome = path.join(root, "profile-keyed-home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true })
    fs.mkdirSync(userDataRoot, { recursive: true })
    const profiles = new AuthProfileStore(userDataRoot)
    await profiles.withOperation((operation) => {
      operation.create("default").close()
      operation.create("work").close()
    })

    await withProjectRuntime({ executionCwd: projectRoot, projectRoot, accountHome, userDataRoot }, async (client) => {
      const target = { kind: "singleton", providerId: "openai_api" } as const
      const initial = await client.query({ type: "provider_models.query", profileId: "default", target })
      const settledDefault = await waitFor(
        "the default profile metadata refresh",
        () => client.query({ type: "provider_models.query", profileId: "default", target }),
        (view) => view.eligibilityRevision > initial.eligibilityRevision,
      )
      const defaults = () => client.query({ type: "authStatusSnapshot", scope: { kind: "defaults" as const } })
      const workBeforeActivation = await client.query({ type: "provider_models.query", profileId: "work", target })

      await profiles.writeStickyProfile("work")
      await waitFor("the work profile activation", defaults, (view) => view.auth.profile.id === "work")
      const settledWork = await waitFor(
        "the work profile eligibility refresh",
        () => client.query({ type: "provider_models.query", profileId: "work", target }),
        (view) => view.eligibilityRevision > workBeforeActivation.eligibilityRevision,
      )
      expect(settledWork.eligibilityRevision).toBeGreaterThan(workBeforeActivation.eligibilityRevision)
      expect((await client.query({ type: "provider_models.query", profileId: "default", target })).eligibilityRevision).toBe(settledDefault.eligibilityRevision)

      await profiles.writeStickyProfile("default")
      await waitFor("the default profile reactivation", defaults, (view) => view.auth.profile.id === "default")
      const defaultAgain = await waitFor(
        "the default profile eligibility refresh",
        () => client.query({ type: "provider_models.query", profileId: "default", target }),
        (view) => view.eligibilityRevision > settledDefault.eligibilityRevision,
      )
      expect(defaultAgain.eligibilityRevision).toBeGreaterThan(settledDefault.eligibilityRevision)
      expect((await client.query({ type: "provider_models.query", profileId: "work", target })).eligibilityRevision).toBe(settledWork.eligibilityRevision)

      await profiles.writeStickyProfile("work")
      await waitFor("the work profile reactivation", defaults, (view) => view.auth.profile.id === "work")
      const workAgain = await waitFor(
        "the work profile eligibility reactivation",
        () => client.query({ type: "provider_models.query", profileId: "work", target }),
        (view) => view.eligibilityRevision > settledWork.eligibilityRevision,
      )
      expect(workAgain.profileId).toBe("work")
      expect(workAgain.eligibilityRevision).toBeGreaterThan(settledWork.eligibilityRevision)
      expect((await client.query({ type: "provider_models.query", profileId: "default", target })).eligibilityRevision).toBe(defaultAgain.eligibilityRevision)
    })
  }, 90_000)
})
