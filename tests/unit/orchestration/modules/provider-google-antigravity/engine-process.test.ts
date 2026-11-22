import { describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { launchEngine } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-process.js"
import { gateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/hook-command.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

describe("an engine launch", () => {
  test("a login directory that was removed fails as an engine that cannot start, so the walk fails over at once", async () => {
    const loginDir = join(temporaryDirectory("flywheel-antigravity-launch-"), "removed")
    let spawned = 0
    const launch = launchEngine({
      loginDir,
      launcher: { spawnOwned: () => { spawned += 1; return Promise.reject(new Error("no engine runs in this test")) } },
      host: { account: { home: "/scratch/home", user: "person" }, platform: process.platform, hostEnvironment: {} },
      gateHook: gateHookHandler({ address: join(loginDir, "gate.sock"), loginGateId: "gate" }),
      toolListener: { register: () => { throw new Error("no tool path in this test") }, unregister: () => {} },
      tools: [],
      clientInfo: { name: "flywheel", version: "0.0.0-test" },
    })
    expect(launch).rejects.toMatchObject({ name: "EngineUnavailableError", reason: "launch-failed" })
    expect(await launch.catch((error: unknown) => error)).toBeInstanceOf(RouteUnavailableError)
    expect(spawned).toBe(0)
  })

  test("on a login that another live Flywheel process serves is refused as login-in-use before it writes any file of the login or runs anything", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-launch-")
    // The test runner that started this process is alive and is not this process: it owns the login.
    mkdirSync(join(loginDir, "processes"), { recursive: true })
    writeFileSync(join(loginDir, "processes", "other.json"), JSON.stringify({ pid: process.ppid, pendingOpens: 0, sessions: [] }))
    let ran = 0
    const launch = launchEngine({
      loginDir,
      launcher: { spawnOwned: () => { ran += 1; return Promise.reject(new Error("no engine runs in this test")) } },
      host: { account: { home: "/scratch/home", user: "person" }, platform: process.platform, hostEnvironment: {} },
      gateHook: gateHookHandler({ address: join(loginDir, "gate.sock"), loginGateId: "gate" }),
      toolListener: { register: () => { throw new Error("no tool path in this test") }, unregister: () => {} },
      tools: [],
      clientInfo: { name: "flywheel", version: "0.0.0-test" },
    })
    await expect(launch).rejects.toMatchObject({ name: "EngineUnavailableError", reason: "login-in-use" })
    expect({ ran, files: readdirSync(loginDir, { recursive: true }).toSorted() }).toEqual({ ran: 0, files: ["processes", join("processes", "other.json")] })
  })
})
