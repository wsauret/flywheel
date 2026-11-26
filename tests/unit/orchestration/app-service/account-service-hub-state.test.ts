import { describe, expect, test } from "bun:test"

import type { AccountService, ProjectSlot } from "../../../../src/orchestration/app-service/account/account-service.js"
import { startAccountWebAddresses, type ProjectBrowserState } from "../../../../src/orchestration/app-service/account/account-web-addresses.js"
import type { ControlUiAssetState } from "../../../../src/orchestration/app-service/account/web-serving/control-ui-assets.js"
import type { AccountHubOptions, AccountHubProject } from "../../../../src/orchestration/app-service/account/web-serving/hub.js"
import { ServeStartupFailure } from "../../../../src/protocol/runtime/serve-handshake.js"

const record = { id: "opaque-a", projectRoot: "/work/alpha", label: "alpha", lastAttachedAt: 1 }
const resolved = { kind: "resolved" as const, root: "/build/webview", identity: "a".repeat(64) }

interface Runtime {
  readonly browserState: ProjectBrowserState | undefined
  readonly openBrowser: () => Promise<string>
  readonly holdClient: () => () => void
  readonly dispose: () => Promise<void>
}

function browserProject(browserState: ProjectBrowserState | undefined): Runtime {
  return { browserState, openBrowser: async () => "", holdClient: () => () => {}, dispose: async () => {} }
}

const runtime = browserProject({ kind: "ready", link: "http://127.0.0.1:43110/#token=a" })

/** The hub's listing of the one registered project while the service holds
 *  `slot` for it and the web client's files are in `assets`. The addresses
 *  stop before they read the registry, so no project address binds. */
async function hubReading(slot: ProjectSlot<Runtime> | undefined, assets: ControlUiAssetState): Promise<AccountHubProject | undefined> {
  let hub: AccountHubOptions | undefined
  const service: AccountService<Runtime> = {
    open: async () => { throw new Error("the hub's listing opens no project") },
    close: async () => {},
    closeFor: async () => { throw new Error("the hub's listing closes no project") },
    state: () => undefined,
    project: () => slot,
    slots: () => new Map(),
    watch: () => () => {},
    openAdmission: () => false,
    closeAdmission: () => {},
    dispose: async () => {},
  }
  startAccountWebAddresses({
    lane: "installed",
    service,
    registry: { list: async () => [record], forget: async () => {} },
    assets: { prepare: () => assets, openable: async () => {} },
    startHub: (options) => {
      hub = options
      return { origin: "http://127.0.0.1:43100", held: () => true, stop: () => {} }
    },
  }).stop()
  if (hub === undefined) throw new Error("the addresses started no hub")
  return (await hub.listProjects())[0]
}

describe("the hub's view of a project", () => {
  test("stays starting until the web client can be served, then opens with its link", async () => {
    expect(await hubReading(undefined, resolved)).toMatchObject({ state: "asleep" })
    expect(await hubReading({ state: "opening", opening: Promise.resolve(runtime) }, resolved)).toMatchObject({ state: "starting" })
    // The composition is open but the client's files are still being located
    // or built: a redirect now would land on the placeholder page.
    expect(await hubReading({ state: "open", runtime }, { kind: "preparing" })).toMatchObject({ state: "starting" })
    expect(await hubReading({ state: "open", runtime }, resolved)).toMatchObject({ state: "open", link: "http://127.0.0.1:43110/#token=a" })
    expect(await hubReading({ state: "open", runtime }, { kind: "failed", error: "the web client is not at /build/webview" })).toMatchObject({ state: "unavailable", error: "the web client is not at /build/webview" })
    expect(await hubReading({ state: "failed", error: new Error("could not start") }, resolved)).toMatchObject({ state: "failed", error: "could not start" })
  })

  test("shows the owned browser start as pending or unavailable without marking the project itself failed", async () => {
    expect(await hubReading({ state: "open", runtime: browserProject(undefined) }, resolved)).toMatchObject({ state: "starting" })
    expect(await hubReading({ state: "open", runtime: browserProject({ kind: "failed", error: "listener failed" }) }, resolved)).toMatchObject({ state: "unavailable", error: "listener failed" })
  })

  test("a project a newer release saved reads as the same refusal and update every client shows", async () => {
    const refused = new Error("project state is unavailable", { cause: new ServeStartupFailure("newer state", { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 }) })
    expect(await hubReading({ state: "failed", error: refused }, resolved)).toMatchObject({
      state: "failed",
      error: "Flywheel cannot open this project: a newer Flywheel release saved its state (state version 99; this release reads version 2). Update Flywheel with `flywheel update`, then open the project again.",
    })
  })

  test("reports closing separately from opening", async () => {
    expect(await hubReading({ state: "closing", closing: Promise.resolve() }, resolved)).toMatchObject({ state: "closing" })
  })
})
