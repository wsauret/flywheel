import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"

import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { projectWebPort, projectWebTokenPath } from "../../../src/infra/paths.js"
import { projectServingPids } from "../../../src/orchestration/app-service/project-serving-lane.js"
import { createIsolatedAccountRuntimeAttach, joinIsolatedAccountService } from "./_account-service.js"
import { createReplacementHarness, LANE, until } from "./_replacement-harness.js"

// What a replacement leaves a surface attached to a project with no running
// work. A terminal or an editor dials the account service, which opens the
// project again on its own; a browser page redials only its project's own
// address, so that project must be served again without it asking.
const harness = createReplacementHarness("replacement-surfaces")
const { tmp, base, makeProject, setInstalledBuild, requestCutover, serviceListening, startSuccessor, stopAccountService, handoffRows } = harness

afterAll(async () => {
  await harness.dispose()
}, 60_000)

/** The local web client's socket to its project, as the page opens it: at
 *  the project's own address, from the page's origin, with the project's
 *  token as its subprotocol. Resolves once the project admits it, and
 *  rejects when nothing admits it. */
function openPage(projectRoot: string): Promise<WebSocket> {
  const origin = `http://127.0.0.1:${projectWebPort(projectRoot)}`
  const token = fs.readFileSync(projectWebTokenPath(base.userDataRoot, projectRoot), "utf8").trim()
  // Bun's constructor takes the handshake headers a browser sends; the DOM
  // library this project compiles against types only the browser's.
  const options: Bun.WebSocketOptions = { protocols: [token], headers: { Origin: origin } }
  const socket: WebSocket = Reflect.construct(WebSocket, [`ws://127.0.0.1:${projectWebPort(projectRoot)}/socket`, options])
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error("the page's project did not admit it")), { once: true })
  })
}

/** The page's own reconnect: it dials until its project admits it. */
async function pageReattaches(projectRoot: string): Promise<WebSocket> {
  const attached = await until("the page's project serves it again", () => openPage(projectRoot).catch(() => undefined), (socket) => socket !== undefined)
  if (attached === undefined) throw new Error("the page did not reattach")
  return attached
}

describe("a surface attached to an idle project across a replacement", () => {
  test("a browser page on a project with no running work is served again by the successor, with nobody acting", async () => {
    const project = makeProject("project-page")
    // A terminal holds the project while the page opens, as `flywheel web`
    // opens it, and then leaves, so the page is the only surface attached.
    const terminal = await harness.attach(project)
    let page: WebSocket
    try {
      await terminal.client.query({ type: "snapshot" })
      await createIsolatedAccountRuntimeAttach({ ...base, projectRoot: project, executionCwd: project }).openProject()
      page = await openPage(project)
    } finally {
      await terminal.dispose()
    }
    const closed = new Promise<void>((resolve) => page.addEventListener("close", () => resolve(), { once: true }))

    // The project's executor may still be starting, which holds the
    // replacement until it serves; nothing else does.
    setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
    expect(["busy", "retiring"]).toContain(await requestCutover())
    await until("service withdrawn", serviceListening, (listening) => !listening)
    expect(await joinIsolatedAccountService(base.userDataRoot)).toBe(SERVE_EXIT.restart)
    await closed
    await startSuccessor(tmp)

    const again = await pageReattaches(project)
    await until("handoff retired", async () => handoffRows().length, (count) => count === 0)
    // The successor holds the project only while a surface does: once the
    // page leaves, the project closes after its idle grace.
    expect(projectServingPids(project, LANE)).not.toEqual([])
    again.close()
    await until("the project closes once the page leaves", async () => projectServingPids(project, LANE).length, (count) => count === 0)
    await stopAccountService()
  }, 180_000)
})
