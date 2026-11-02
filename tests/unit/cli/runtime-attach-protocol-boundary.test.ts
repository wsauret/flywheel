import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAccountRuntimeAttach, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import type { TerminalSuccessor } from "../../../src/cli/terminal-handoff.js"
import { currentBuildLink, versionsDir } from "../../../src/infra/paths.js"
import { useWin32ContainedDirectories } from "../../helpers/win32-contained-directories.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { installedBuildId, readRunningBuild } from "../../../src/orchestration/app-service/runtime-executable.js"

describe("account runtime attach at a protocol boundary", () => {
  const NEXT = RUNTIME_PROTOCOL_VERSION + 1
  const serving = { pid: 2, holder: { kind: "without-identity", pid: 2 }, version: "source", protocolVersion: NEXT, buildId: `source:protocol-${NEXT}` } satisfies RuntimeIdentity

  function boundaryAttach(root: string, seams: Parameters<typeof createAccountRuntimeAttach>[1], followed: TerminalSuccessor[]) {
    return createAccountRuntimeAttach({
      projectRoot: root,
      executionCwd: root,
      accountHome: root,
      userDataRoot: join(root, ".flywheel"),
      allowPersistentProcesses: true,
      follow: async (target) => {
        followed.push(target)
        throw new Error("followed")
      },
    }, { installedBuildId: () => serving.buildId, sleep: async () => {}, ...seams })
  }

  test("follows a service of the current build that speaks another protocol into the checkout that serves it", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-boundary-"))
    const followed: TerminalSuccessor[] = []
    let cutovers = 0
    try {
      const attach = boundaryAttach(root, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => serving,
        requestReplacement: async () => { cutovers += 1; return "busy" },
      }, followed)

      await expect(attach.ensure(() => {})).rejects.toThrow("followed")

      expect(cutovers).toBe(0)
      expect(followed).toHaveLength(1)
      expect(followed[0]?.command.at(-1)).toEndWith(join("scripts", "dev.ts"))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  describe("on the Windows backend", () => {
    useWin32ContainedDirectories();

    test("on Windows follows the build the pointer activated, by the build it read at its start", async () => {
      const root = mkdtempSync(join(tmpdir(), "flywheel-attach-boundary-windows-"))
      const userDataRoot = join(root, ".flywheel")
      const place = (buildId: string): string => {
        const directory = join(versionsDir(userDataRoot), "0.1.0", buildId)
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, "build.json"), JSON.stringify({ version: "0.1.0", buildId, asset: "flywheel-win32-x64.tar.gz" }))
        writeFileSync(join(directory, "flywheel-bin.exe"), "")
        return join(directory, "flywheel-bin.exe")
      }
      const windows = { platform: "win32" as const, execPath: place("a".repeat(64)) }
      const updated = { pid: 2, holder: { kind: "without-identity", pid: 2 }, version: "0.1.0", protocolVersion: NEXT, buildId: "b".repeat(64) } satisfies RuntimeIdentity
      try {
        const atStart = readRunningBuild(windows)
        // An update activates a newer build, which serves in a protocol this
        // terminal cannot speak.
        place(updated.buildId)
        writeFileSync(currentBuildLink(userDataRoot), `versions\\0.1.0\\${updated.buildId}`)
        const followed: TerminalSuccessor[] = []
        await expect(boundaryAttach(root, {
          runningBuild: atStart,
          installedBuildId: (directories) => installedBuildId(directories, windows),
          isRuntimeListening: async () => true,
          readRuntimeIdentity: () => updated,
        }, followed).ensure(() => {})).rejects.toThrow("followed")
        expect(followed).toHaveLength(1)
        // The build this terminal runs is its own immutable directory, so
        // reading it again still names the build it started from.
        expect(readRunningBuild(windows)).toEqual(atStart)
      } finally { rmSync(root, { recursive: true, force: true }) }
    })
  });

  test("follows the service it launched when that service speaks another protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-boundary-launch-"))
    const followed: TerminalSuccessor[] = []
    let launched = false
    try {
      const attach = boundaryAttach(root, {
        isRuntimeListening: async () => launched,
        readRuntimeIdentity: () => launched ? serving : undefined,
        launchRuntime: async () => { launched = true },
      }, followed)

      await expect(attach.ensure(() => {})).rejects.toThrow("followed")

      expect(followed).toHaveLength(1)
      expect(followed[0]?.command.at(-1)).toEndWith(join("scripts", "dev.ts"))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("follows a successor of the current build that appears while a busy older service finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-boundary-successor-"))
    const followed: TerminalSuccessor[] = []
    let reads = 0
    try {
      const attach = boundaryAttach(root, {
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => {
          reads += 1
          return reads <= 2 ? { pid: 1, holder: { kind: "without-identity", pid: 1 }, version: "0.0.10", protocolVersion: RUNTIME_PROTOCOL_VERSION - 3, buildId: "old" } : serving
        },
        requestReplacement: async () => "busy",
      }, followed)

      await expect(attach.ensure(() => {})).rejects.toThrow("followed")

      expect(followed).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("faults instead when the service names this terminal's own build", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-attach-boundary-own-"))
    const followed: TerminalSuccessor[] = []
    try {
      const own = `source:protocol-${RUNTIME_PROTOCOL_VERSION}`
      const attach = boundaryAttach(root, {
        installedBuildId: () => own,
        isRuntimeListening: async () => true,
        readRuntimeIdentity: () => ({ ...serving, buildId: own }),
      }, followed)

      await expect(attach.ensure(() => {})).rejects.toThrow(`the account service speaks protocol ${NEXT} and this client requires ${RUNTIME_PROTOCOL_VERSION}`)
      expect(followed).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
