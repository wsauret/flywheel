import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { servingBuild, type ServingBuildInput } from "../../../src/cli/serving-build.js"
import { versionsDir } from "../../../src/infra/paths.js"

const BUILD = "a".repeat(64)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function input(overrides: Partial<ServingBuildInput> = {}): ServingBuildInput {
  const userDataRoot = mkdtempSync(join(tmpdir(), "flywheel-serving-build-"))
  roots.push(userDataRoot)
  return {
    lane: "installed",
    platform: "darwin",
    platformArch: "darwin-arm64",
    userDataRoot,
    identity: { pid: 7, holder: { kind: "without-identity", pid: 7 }, version: "1.2.3", protocolVersion: 99, buildId: BUILD },
    ownBuild: "b".repeat(64),
    sourceCommand: ["bun", "--conditions=browser", "/repo/scripts/dev.ts"],
    ...overrides,
  }
}

function installBuild(userDataRoot: string, version: string, buildId: string, platformArch = "darwin-arm64", executable = "flywheel-bin"): string {
  const directory = join(versionsDir(userDataRoot), version, buildId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "build.json"), JSON.stringify({ version, buildId, asset: `flywheel-${platformArch}.tar.gz` }))
  writeFileSync(join(directory, executable), "#!/bin/sh\n")
  chmodSync(join(directory, executable), 0o755)
  return directory
}

describe("the serving build", () => {
  test("is the installed build the service names, run through its launcher's environment", () => {
    const given = input()
    const directory = installBuild(given.userDataRoot, "1.2.3", BUILD)
    expect(servingBuild(given)).toEqual({
      version: "1.2.3",
      command: [join(directory, "flywheel-bin")],
      env: { FLYWHEEL_NATIVE_DIR: join(directory, "native", "darwin-arm64") },
    })
  })

  test("runs a musl build with the native directory of its own target", () => {
    const given = input({ platform: "linux", platformArch: "linux-x64-musl" })
    const directory = installBuild(given.userDataRoot, "1.2.3", BUILD, "linux-x64-musl")
    expect(servingBuild(given)).toEqual({
      version: "1.2.3",
      command: [join(directory, "flywheel-bin")],
      env: { FLYWHEEL_NATIVE_DIR: join(directory, "native", "linux-x64-musl") },
    })
  })

  test("is the checkout's own entry on the development lane", () => {
    expect(servingBuild(input({ lane: "dev", identity: { pid: 7, holder: { kind: "without-identity", pid: 7 }, version: "source", protocolVersion: 99, buildId: "source:protocol-99" } })))
      .toEqual({ version: "source", command: ["bun", "--conditions=browser", "/repo/scripts/dev.ts"], env: {} })
  })

  test("is the Windows build's own executable in the versions home", () => {
    const given = input({ platform: "win32", platformArch: "win32-x64" })
    const directory = installBuild(given.userDataRoot, "1.2.3", BUILD, "win32-x64", "flywheel-bin.exe")
    expect(servingBuild(given)).toEqual({
      version: "1.2.3",
      command: [join(directory, "flywheel-bin.exe")],
      env: { FLYWHEEL_NATIVE_DIR: join(directory, "native", "win32-x64") },
    })
  })

  test("is nothing to follow when the service names this terminal's own build or no build", () => {
    expect(typeof servingBuild(input({ ownBuild: BUILD }))).toBe("string")
    expect(typeof servingBuild(input({ identity: { pid: 7, holder: { kind: "without-identity", pid: 7 }, version: "1.2.3", protocolVersion: 99 } }))).toBe("string")
  })

  test("is refused when the named build is not installed or names a path outside the versions home", () => {
    expect(servingBuild(input())).toEqual(expect.stringContaining("is not installed"))
    expect(servingBuild(input({ identity: { pid: 7, holder: { kind: "without-identity", pid: 7 }, version: "..", protocolVersion: 99, buildId: BUILD } }))).toEqual(expect.stringContaining("outside the versions home"))
    const given = input()
    installBuild(given.userDataRoot, "1.2.3", BUILD)
    expect(servingBuild({ ...given, identity: { ...given.identity, buildId: `../1.2.3/${BUILD}` } })).toEqual(expect.stringContaining("outside the versions home"))
  })
})
