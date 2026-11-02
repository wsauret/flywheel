import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { AuthProfileManager } from "../../../src/orchestration/auth/auth-profile-manager.js"
import { AuthProfileStore } from "../../../src/infra/auth/auth-profile-store.js"
import { attachProjectRuntime, canonicalDirectories, stopProjectRuntime } from "./_project-runtime.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// Short on purpose: the runtime binds a unix socket under this account home,
// and a socket path is bounded (104 bytes on macOS).
const root = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-auth-scope-"))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function waitFor<T>(what: string, read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const value = await read()
    if (matches(value)) return value
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

describe("cross-owner auth profile observation", () => {
  test("updates defaults across owners without changing an active session identity", async () => {
    const accountHome = path.join(root, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    const firstProject = path.join(root, "first-project")
    const secondProject = path.join(root, "second-project")
    fs.mkdirSync(path.join(firstProject, ".git"), { recursive: true })
    fs.mkdirSync(path.join(secondProject, ".git"), { recursive: true })
    fs.mkdirSync(userDataRoot, { recursive: true })

    const profiles = new AuthProfileStore(userDataRoot)
    await profiles.withOperation((operation) => {
      operation.create("default").close()
      operation.create("work").close()
      operation.create("client").close()
    })

    const firstDirectories = canonicalDirectories({ executionCwd: firstProject, projectRoot: firstProject, accountHome, userDataRoot })
    const secondDirectories = canonicalDirectories({ executionCwd: secondProject, projectRoot: secondProject, accountHome, userDataRoot })
    let disposeFirst: (() => Promise<void>) | undefined
    let disposeSecond: (() => Promise<void>) | undefined
    try {
      const first = await attachProjectRuntime(firstDirectories)
      disposeFirst = first.dispose
      const firstDefaults = () => first.client.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
      const initialDefaults = await firstDefaults()
      expect(initialDefaults.auth.profile.id).toBe("default")

      // The runtime refreshes provider metadata in the background after it
      // opens and republishes its defaults when that lands, at a time the
      // network decides. The rename below is observed only after that
      // publication, so the window holds nothing but the rename's own patch.
      const initialRevision = initialDefaults.auth.autoEnableNewModels?.eligibilityRevision ?? 0
      const authCursors: string[] = []
      let defaultsRefreshed = false
      const unsubscribeAuth = first.client.subscribe((event) => {
        if (event.type !== "patch" || event.patch.payload.kind !== "auth.changed") return
        const cursor = event.patch.cursor
        if (cursor.scope === "session") {
          authCursors.push(`session:${cursor.sessionId}`)
          return
        }
        authCursors.push("workspace")
        if ((event.patch.payload.auth.autoEnableNewModels?.eligibilityRevision ?? 0) > initialRevision) defaultsRefreshed = true
      })
      await first.client.query({ type: "snapshot" })

      const second = await attachProjectRuntime(secondDirectories)
      disposeSecond = second.dispose
      const secondDefaults = () => second.client.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
      expect((await secondDefaults()).auth.profile.id).toBe("default")

      const opened = await first.client.dispatch({ type: "chat.open" })
      expect(opened.ok).toBe(true)
      if (!opened.ok || opened.sessionId === undefined) throw new Error("first owner did not open a session")
      const sessionId = opened.sessionId
      const sessionScope = { kind: "session" as const, sessionId }
      expect((await first.client.query({ type: "authStatusSnapshot", scope: sessionScope })).auth.profile.id).toBe("default")

      try {
        await waitFor("the refreshed defaults publication", async () => defaultsRefreshed, (refreshed) => refreshed)
        authCursors.length = 0
        // The account bus declines a value equal to the last one on its
        // cursor until a read of its domain comes after it (ARCH-PROTOCOL-011). This
        // read voids every auth baseline, so the rename's publication shows
        // each scope it reaches, and a workspace patch would show here too.
        await first.client.query({ type: "authStatusSnapshot", scope: sessionScope })
        expect(await first.client.dispatch({ type: "session.rename", sessionId, title: "Scoped session" })).toMatchObject({ ok: true, sessionId })
        await waitFor("the changed session auth patch", async () => authCursors, (cursors) => cursors.length > 0)
        expect(authCursors).toEqual([`session:${sessionId}`])
      } finally {
        unsubscribeAuth()
      }

      await profiles.writeStickyProfile("work")
      await waitFor("first owner sticky default", firstDefaults, (view) => view.auth.profile.id === "work")
      await waitFor("second owner sticky default", secondDefaults, (view) => view.auth.profile.id === "work")
      expect((await first.client.query({ type: "authStatusSnapshot", scope: sessionScope })).auth.profile.id).toBe("default")
      const openedAfterSwitch = await first.client.dispatch({ type: "chat.open" })
      expect(openedAfterSwitch.ok).toBe(true)
      if (!openedAfterSwitch.ok || openedAfterSwitch.sessionId === undefined) throw new Error("first owner did not open a second session")
      const switchedSessionScope = { kind: "session" as const, sessionId: openedAfterSwitch.sessionId }
      expect((await first.client.query({ type: "authStatusSnapshot", scope: switchedSessionScope })).auth.profile.id).toBe("work")

      // The runtime resolves its project root through the filesystem; the binding
      // it watches is keyed by that resolved spelling.
      const secondManager = new AuthProfileManager({ userDataRoot, projectRoot: secondDirectories.projectRoot })
      expect((await secondManager.bind("client")).ok).toBe(true)
      await waitFor("second owner project default", secondDefaults, (view) => view.auth.profile.id === "client")
      expect((await firstDefaults()).auth.profile.id).toBe("work")
      expect((await first.client.query({ type: "authStatusSnapshot", scope: sessionScope })).auth.profile.id).toBe("default")
      expect((await first.client.query({ type: "authStatusSnapshot", scope: switchedSessionScope })).auth.profile.id).toBe("work")
    } finally {
      await disposeSecond?.()
      await disposeFirst?.()
      await stopProjectRuntime(secondDirectories)
      await stopProjectRuntime(firstDirectories)
    }
  }, 90_000)
})
