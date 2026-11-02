import { describe, expect, test } from "bun:test"

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { currentBuildLink, versionsDir } from "../../../../src/infra/paths.js"
import { checkoutProtocolVersion, installedBuildId, installedExecutable, readRunningBuild, runningBuildId, runningDisplayBuildId, sourceBuildId } from "../../../../src/orchestration/app-service/runtime-executable.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../../src/protocol/runtime-liveness.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js"
import { snapshotFixture } from "../../../helpers/source-snapshot-fixture.js"

const temporaryDirectory = temporaryDirectories()

describe("a source checkout's build identity", () => {
  test("is the protocol version the checkout's source declares", () => {
    expect(checkoutProtocolVersion()).toBe(RUNTIME_PROTOCOL_VERSION)
    expect(sourceBuildId(RUNTIME_PROTOCOL_VERSION)).toBe(`source:protocol-${RUNTIME_PROTOCOL_VERSION}`)
    expect(sourceBuildId(RUNTIME_PROTOCOL_VERSION)).not.toBe(sourceBuildId(RUNTIME_PROTOCOL_VERSION + 1))
  })

  test("is read from the checkout, not from the snapshot a dev service runs", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-protocol-"), ["src/orchestration/app-service/runtime-executable.ts"])
    mkdirSync(join(fixture.checkout, "src", "protocol"), { recursive: true })
    writeFileSync(join(fixture.checkout, "src", "protocol", "runtime-liveness.ts"), `export const RUNTIME_PROTOCOL_VERSION = ${RUNTIME_PROTOCOL_VERSION + 1}\n`)
    const snapshotted = await fixture.importFromSnapshot<typeof import("../../../../src/orchestration/app-service/runtime-executable.js")>("src/orchestration/app-service/runtime-executable.ts")

    expect(snapshotted.checkoutProtocolVersion()).toBe(RUNTIME_PROTOCOL_VERSION + 1)
  })

  test("is displayed as the snapshot digest it runs from, and as unknown from a live checkout", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-display-"), ["src/orchestration/app-service/runtime-executable.ts"])
    const snapshotted = await fixture.importFromSnapshot<typeof import("../../../../src/orchestration/app-service/runtime-executable.js")>("src/orchestration/app-service/runtime-executable.ts")

    expect(snapshotted.runningDisplayBuildId({ kind: "source" })).toBe("0123456789abcdef")
    expect(runningDisplayBuildId({ kind: "source" })).toBeNull()
  })
})

/** One build in an account's versions home, with the executable of its
 *  platform, as the install engine leaves it. */
function placeBuild(userDataRoot: string, version: string, buildId: string, platform: "darwin" | "win32"): string {
  const directory = join(versionsDir(userDataRoot), version, buildId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "build.json"), JSON.stringify({ version, buildId, asset: `flywheel-${platform === "win32" ? "win32-x64" : "darwin-arm64"}.tar.gz` }))
  const executable = join(directory, platform === "win32" ? "flywheel-bin.exe" : "flywheel-bin")
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 })
  return executable
}

describe("the installed runtime command", () => {
  test("is the account's launcher for a build of its versions home, and nothing from a source checkout", () => {
    const root = temporaryDirectory("flywheel-installed-command-")
    const userDataRoot = join(root, ".flywheel")
    const windowsBuild = placeBuild(userDataRoot, "1.0.0", "a".repeat(64), "win32")
    const posixBuild = placeBuild(userDataRoot, "1.0.0", "b".repeat(64), "darwin")

    expect(installedExecutable({ platform: "win32", userDataRoot, accountHome: root, installDirectory: "D:\\tools\\flywheel", execPath: windowsBuild })).toBe("D:\\tools\\flywheel\\flywheel.exe")
    expect(installedExecutable({ platform: "darwin", userDataRoot, accountHome: root, installDirectory: undefined, execPath: posixBuild })).toBe(join(root, ".local", "bin", "flywheel"))
    expect(installedExecutable({ platform: "win32", userDataRoot, accountHome: root, installDirectory: undefined, execPath: "C:\\bun\\bun.exe" })).toBeUndefined()
    // A Bun binary outside the versions root is a source checkout.
    expect(installedExecutable({ platform: "darwin", userDataRoot: "/nonexistent/.flywheel", accountHome: "/h", installDirectory: undefined, execPath: process.execPath })).toBeUndefined()
  })
})

describe("the installed build identity", () => {
  useWin32ContainedDirectories()

  test("on Windows is the build the pointer names, and nothing before the first activation", () => {
    const root = temporaryDirectory("flywheel-installed-build-")
    const userDataRoot = join(root, ".flywheel")
    const directories = { userDataRoot, accountHome: root, projectRoot: root, executionCwd: root }
    const running = placeBuild(userDataRoot, "0.0.9", "e".repeat(64), "win32")
    placeBuild(userDataRoot, "0.0.10", "f".repeat(64), "win32")
    const host = { platform: "win32" as const, execPath: running }

    expect(installedBuildId(directories, host)).toBeUndefined()
    writeFileSync(currentBuildLink(userDataRoot), `versions\\0.0.10\\${"f".repeat(64)}`)
    expect(installedBuildId(directories, host)).toBe("f".repeat(64))
  })
})

describe("the running build identity", () => {
  test("is read off this process's own executable, so an install that activates a newer build does not change it", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-running-build-"))
    const userDataRoot = join(root, ".flywheel")
    const directories = { userDataRoot, accountHome: root, projectRoot: root, executionCwd: root }
    const executableName = process.platform === "win32" ? "flywheel-bin.exe" : "flywheel-bin"
    const build = (version: string, buildId: string): string => {
      const directory = join(versionsDir(userDataRoot), version, buildId)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "build.json"), JSON.stringify({ version, buildId, asset: `flywheel-${process.platform}-${process.arch}.tar.gz` }))
      writeFileSync(join(directory, executableName), "#!/bin/sh\n", { mode: 0o755 })
      return directory
    }
    const activate = (directory: string): void => {
      if (process.platform === "win32") writeFileSync(currentBuildLink(userDataRoot), relative(userDataRoot, directory))
      else symlinkSync(directory, currentBuildLink(userDataRoot))
    }
    try {
      const running = build("1.0.0", "a".repeat(64))
      const newer = build("1.1.0", "b".repeat(64))
      const host = { platform: process.platform, execPath: join(running, executableName) }
      activate(running)
      const started = readRunningBuild(host)
      expect(runningBuildId(started, directories)).toBe("a".repeat(64))
      expect(runningDisplayBuildId(started)).toBe("a".repeat(64))
      // An install activates the newer build after this process started.
      rmSync(currentBuildLink(userDataRoot))
      activate(newer)
      expect(installedBuildId(directories, host)).toBe("b".repeat(64))
      expect(runningBuildId(started, directories)).toBe("a".repeat(64))
      expect(runningDisplayBuildId(started)).toBe("a".repeat(64))
      expect(runningDisplayBuildId({ kind: "unknown" })).toBeNull()
      // A build of another account's versions home is not this account's.
      expect(runningBuildId(readRunningBuild(host), { userDataRoot: join(root, "elsewhere") })).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("is the protocol this source run was loaded with, and on Windows the build directory of the executable", () => {
    const root = temporaryDirectory("flywheel-running-build-")
    const userDataRoot = join(root, ".flywheel")
    const directories = { userDataRoot, accountHome: root, projectRoot: root, executionCwd: root }
    expect(runningBuildId(readRunningBuild({ execPath: process.execPath }), directories)).toBe(sourceBuildId(RUNTIME_PROTOCOL_VERSION))
    const started = readRunningBuild({ execPath: placeBuild(userDataRoot, "0.0.9", "f".repeat(64), "win32") })
    // An update activates another build by its pointer; the build this
    // process runs is the directory it started from.
    placeBuild(userDataRoot, "0.1.0", "e".repeat(64), "win32")
    writeFileSync(currentBuildLink(userDataRoot), `versions\\0.1.0\\${"e".repeat(64)}`)
    expect(runningBuildId(started, directories)).toBe("f".repeat(64))
  })
})
