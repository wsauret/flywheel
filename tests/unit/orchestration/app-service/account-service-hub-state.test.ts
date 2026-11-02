import { describe, expect, test } from "bun:test"

import { hubProject } from "../../../../src/orchestration/app-service/account-web-addresses.js"
import { ServeStartupFailure } from "../../../../src/protocol/serve-handshake.js"

const record = { id: "opaque-a", projectRoot: "/work/alpha", label: "alpha", lastAttachedAt: 1 }
const runtime = { browserState: { kind: "ready" as const, link: "http://127.0.0.1:43110/#token=a" } }

describe("the hub's view of a project", () => {
  test("stays starting until the web client can be served, then opens with its link", () => {
    expect(hubProject(record, undefined, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({ state: "asleep" })
    expect(hubProject(record, { state: "opening", opening: Promise.resolve(runtime) }, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({ state: "starting" })
    // The composition is open but the client's files are still being located
    // or built: a redirect now would land on the placeholder page.
    expect(hubProject(record, { state: "open", runtime }, { kind: "preparing" })).toMatchObject({ state: "starting" })
    expect(hubProject(record, { state: "open", runtime }, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({ state: "open", link: runtime.browserState.link })
    expect(hubProject(record, { state: "open", runtime }, { kind: "failed", error: "the web client is not at /build/webview" })).toMatchObject({ state: "unavailable", error: "the web client is not at /build/webview" })
    expect(hubProject(record, { state: "failed", error: new Error("could not start") }, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({ state: "failed", error: "could not start" })
  })

  test("shows the owned browser start as pending or unavailable without marking the project itself failed", () => {
    const assets = { kind: "resolved" as const, root: "/build/webview", identity: "a".repeat(64) }
    expect(hubProject(record, { state: "open", runtime: { browserState: undefined } }, assets)).toMatchObject({ state: "starting" })
    expect(hubProject(record, { state: "open", runtime: { browserState: { kind: "failed", error: "listener failed" } } }, assets)).toMatchObject({ state: "unavailable", error: "listener failed" })
  })

  test("a project a newer release saved reads as the same refusal and update every client shows", () => {
    const refused = new Error("project state is unavailable", { cause: new ServeStartupFailure("newer state", { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 }) })
    expect(hubProject(record, { state: "failed", error: refused }, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({
      state: "failed",
      error: "Flywheel cannot open this project: a newer Flywheel release saved its state (state version 99; this release reads version 2). Update Flywheel with `flywheel update`, then open the project again.",
    })
  })

  test("reports closing separately from opening", () => {
    expect(hubProject(record, { state: "closing", closing: Promise.resolve() }, { kind: "resolved", root: "/build/webview", identity: "a".repeat(64) })).toMatchObject({ state: "closing" })
  })
})
