import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { StartupDirectories } from "../../../src/infra/directory-authorities.js"
import { globalConfigFile } from "../../../src/infra/paths.js"
import { isProcessAlive } from "../../../src/infra/process-liveness.js"
import { seedConfigDefaults } from "../../../src/orchestration/config/writer.js"
import { migrateCapabilityModules } from "../../../src/orchestration/config/module-selection-writer.js"
import { readDefinitionOverrideBaselines } from "../../../src/workflows/definitions/override-baselines.js"

import { withProjectRuntime as withRuntime } from "./_project-runtime.js"

describe.skipIf(process.platform !== "win32")("Windows production startup", () => {
  test("starts and reopens the complete composition under a path with spaces", async () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-phase-10-")))
    const accountHome = join(tempRoot, "Account Home")
    const userDataRoot = join(accountHome, ".flywheel")
    const projectRoot = join(tempRoot, "VS Code Projects", "Mass-Backtester")
    const executionCwd = projectRoot
    const systemPromptPath = join(userDataRoot, "system-prompt.md")
    const directories: StartupDirectories = { accountHome, userDataRoot, projectRoot, executionCwd }

    mkdirSync(userDataRoot, { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(globalConfigFile(userDataRoot), 'features = ["skills"]\n')
    writeFileSync(systemPromptPath, "# Windows startup smoke override\n")

    try {
      const migration = await migrateCapabilityModules({ userDataRoot })
      expect(migration.write).toEqual({ ok: true })
      const seeded = seedConfigDefaults({ userDataRoot })
      expect(seeded).toEqual({ ok: true })

      const configPath = globalConfigFile(userDataRoot)
      const configText = readFileSync(configPath, "utf8")
      expect(configText).not.toContain("features =")
      expect(configText).toContain("disabled_modules =");
      expect(configText).not.toContain('disabled_modules = ["skills"');
      expect(configText).not.toContain("[providers.github_copilot]")
      expect(configText).not.toContain("monthly_credit_cap")
      expect(configPath).toBe(join(accountHome, ".flywheel", "flywheel.toml"))

      let sessionId: string | undefined
      await withRuntime(directories, async (client) => {
        const events: Array<{ readonly type: string }> = []
        // This client speaks to the runtime across a socket, so its lane
        // opens when the runtime registers the subscription, not when the
        // subscribe call returns. Awaited, not assumed: a query completing
        // says nothing about the lane being open yet.
        const unsubscribe = client.subscribe((event) => { events.push(event) })
        const arrived = new Promise<void>((resolve) => { client.onLane(() => resolve()) })
        try {
          const snapshot = await client.query({ type: "snapshot" })
          await arrived
          expect(snapshot.projectRoot).toBe(realpathSync(projectRoot))
          expect(snapshot.rows).toEqual([])

          const modules = await client.query({ type: "moduleSnapshot" })
          expect(modules.capabilities.capabilities).toContain("skills")

          // This account states the legacy `features = ["skills"]`, and the
          // migration reads it as the whole selection: every other capability
          // module, `workflows` included, is written disabled.
          expect(modules.capabilities.capabilities).not.toContain("workflows")
          const catalog = await client.query({ type: "commandCatalog" })
          expect(catalog).not.toHaveProperty("workflows")

          const staleness = await client.query({ type: "definitionStalenessSnapshot" })
          const override = staleness.definitionStaleness.overrides.find(({ path }) => path === systemPromptPath)
          expect(override).toMatchObject({
            family: "system-prompt",
            layer: "user",
            path: systemPromptPath,
            status: "current",
            snapshotAvailable: true,
          })

          const opened = await client.dispatch({ type: "chat.open" })
          if (!opened.ok || opened.sessionId === undefined) throw new Error("chat.open did not return a session id")
          sessionId = opened.sessionId

          // A blank chat is transient: nothing was said in it, so a stop that
          // no client holds the project through removes it and there would be
          // nothing to reopen. A user rename is deliberate state, which is
          // what makes this session durable enough for the reopen below to
          // mean anything.
          const renamed = await client.dispatch({ type: "session.rename", sessionId, title: "Backtester chat" })
          expect(renamed.ok).toBe(true)

          const openedSnapshot = await client.query({ type: "snapshot" })
          expect(openedSnapshot.rows).toHaveLength(1)
          expect(openedSnapshot.rows[0]?.id).toBe(sessionId)
          expect(openedSnapshot.rows[0]?.executionCwd).toBe(realpathSync(executionCwd))
        } finally {
          unsubscribe()
        }
      })

      const baseline = readDefinitionOverrideBaselines(userDataRoot)
      const baselineRecord = baseline.kind === "readable" ? baseline.records[systemPromptPath] : undefined
      expect(baselineRecord).toBeDefined()
      expect(baselineRecord?.acknowledged_default_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(existsSync(`${systemPromptPath}.base`)).toBe(true)
      expect(existsSync(join(projectRoot, ".flywheel", "flywheel.sqlite"))).toBe(true)
      expect(sessionId).toBeDefined()

      await withRuntime(directories, async (client) => {
        const reopened = await client.query({ type: "snapshot" })
        expect(reopened.projectRoot).toBe(realpathSync(projectRoot))
        expect(reopened.rows).toHaveLength(1)
        expect(reopened.rows[0]?.id).toBe(sessionId)
        expect(reopened.rows[0]?.executionCwd).toBe(realpathSync(executionCwd))
      })

      // Nothing live may still own a lock or the state generation, or the next
      // start waits on it. Windows has no signal that runs another process's
      // graceful path, so a stopped service is terminated and can leave a lock
      // or a shared holder entry that it held at that moment, such as the
      // config lock of a late maintenance write; the next acquisition reclaims
      // an entry whose process is gone. The entry is therefore not the
      // contract: liveness is.
      const liveHolders = (directory: string, isLockEntry: (entry: string) => boolean): string[] =>
        readdirSync(directory)
          .filter(isLockEntry)
          .filter((entry) => {
            const record: unknown = JSON.parse(readFileSync(join(directory, entry), "utf8"))
            const pid = typeof record === "object" && record !== null && "pid" in record && typeof record.pid === "number" ? record.pid : undefined
            return pid === undefined || isProcessAlive(pid)
          })
      expect(liveHolders(userDataRoot, (entry) => entry.endsWith(".lock"))).toEqual([])
      expect(liveHolders(join(projectRoot, ".flywheel"), (entry) => entry.startsWith("project-generation.lock"))).toEqual([])
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
