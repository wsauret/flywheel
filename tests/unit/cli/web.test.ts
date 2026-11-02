import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { runWeb } from "../../../src/cli/web.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const directories = { executionCwd: "/project", projectRoot: "/project", accountHome: "/home/test", userDataRoot: "/home/test/.flywheel" }
afterEach(() => { process.exitCode = 0 })

const temporary = temporaryDirectories()
const harness = { FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1", FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0" }

describe("flywheel web", () => {
  test("ensures account serve before opening its lane's fixed wake page", async () => {
    const events: string[] = []
    await runWeb([], directories, { lane: "installed", socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => { events.push("ensure") }, openProject: async () => { events.push("open") }, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }, async (url) => { events.push(url); return true }, { log: (line) => events.push(line), error: (line) => events.push(line) })
    expect(events.slice(0, 3)).toEqual(["ensure", "open", "http://127.0.0.1:41000/"])
  })
  test("opens the dev lane's own hub for a source run", async () => {
    const events: string[] = []
    await runWeb([], directories, { lane: "dev", socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => {}, openProject: async () => {}, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }, async (url) => { events.push(url); return true }, { log: () => {}, error: () => {} })
    expect(events).toEqual(["http://127.0.0.1:40999/"])
  })
  test("says why the project cannot open in the browser instead of claiming it opened", async () => {
    const events: string[] = []
    await runWeb([], directories, { lane: "installed", socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => {}, openProject: async () => { throw new Error("The web client is unavailable: the web client is not at /build/webview") }, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }, async (url) => { events.push(`open ${url}`); return true }, { log: (line) => events.push(line), error: (line) => events.push(line) })
    expect(events).toEqual(["flywheel web: The web client is unavailable: the web client is not at /build/webview"])
    expect(process.exitCode).toBe(1)
  })
  test("rejects unknown arguments before attachment", async () => {
    let attached = false
    await runWeb(["extra"], directories, { lane: "installed", socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => { attached = true }, openProject: async () => { attached = true }, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }, async () => true, { log() {}, error() {} })
    expect(attached).toBe(false)
    expect(process.exitCode).toBe(1)
  })
  test("opens the hub a release harness service recorded, and never the fixed address without a record", async () => {
    const record = join(temporary("flywheel-web-"), "hub")
    writeFileSync(record, "http://127.0.0.1:59164\n")
    const opened: string[] = []
    const run = (env: { readonly [name: string]: string }) => runWeb([], directories, { lane: "installed", socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => {}, openProject: async () => {}, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }, async (url) => { opened.push(url); return true }, { log() {}, error() {}, env })
    await run({ ...harness, FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: record })
    expect(opened).toEqual(["http://127.0.0.1:59164/"])
    await run(harness)
    expect(opened).toEqual(["http://127.0.0.1:59164/"])
    expect(process.exitCode).toBe(1)
  })
})
