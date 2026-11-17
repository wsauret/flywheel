import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import { EMPTY_REMOTE_VIEW } from "../../../src/protocol/modules/remote.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("composer-status-fixture.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{
    name: "solid-ssr",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
const { renderComposerStatus }: typeof import("./composer-status-fixture.js") = await importBuiltModule(javascript)

describe("composer status", () => {
  test("several failed background reads show one plain notice and successful reads show none", () => {
    const html = renderComposerStatus([], { kind: "healthy" }, undefined, 3)
    assert.equal(html.match(/Some views could not load\. Flywheel keeps trying\./g)?.length, 1)
    assert.equal(html.match(/role="status"/g)?.length, 1)
    assert.doesNotMatch(renderComposerStatus([], { kind: "healthy" }), /Some views could not load/)
  })
  test("web headers omit an enabled remote module's composer reading", () => {
    const html = renderComposerStatus(["remote"], undefined, {
      remote: { ...EMPTY_REMOTE_VIEW, attachedClients: 1, devices: [{ id: "phone", label: "Phone", pairedAt: 1, notifies: false, attached: true }] },
    })
    assert.doesNotMatch(html, /data-module-status="remote"|1 remote/)
  })
  test("a process Flywheel is restarting shows one warning with its cause and no reset", () => {
    const html = renderComposerStatus([], { kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" })
    assert.match(html, /runtime-fault-warning[^>]*>Flywheel(&#39;|')s process for this project stopped again\. Last cause: stopped by signal SIGKILL\./)
    assert.match(html, /Flywheel starts it again\. Open sessions continue when it starts\./)
    assert.doesNotMatch(html, /flywheel kill|runtime-fault-fault/)
  })
  test("a failed recovery shows one fault with its cause and the reset", () => {
    const html = renderComposerStatus([], { kind: "recovery_failed", cause: "some commands it started did not stop" })
    assert.match(html, /runtime-fault-fault[^>]*>Flywheel could not restore this project(&#39;|')s sessions after its process stopped\. Cause: some commands it started did not stop\./)
    assert.match(html, /flywheel kill/)
  })
  test("the fault notice is a status paragraph of its own, not a toolbar chip", () => {
    const html = renderComposerStatus([])
    assert.match(html, /<p[^>]+class="runtime-fault runtime-fault-fault"[^>]*role="status"/)
    assert.match(html, /runtime-fault-fault[^>]*>Flywheel(&#39;|')s background service stopped answering/)
    assert.doesNotMatch(html, /class="connection connection-fault"/)
  })
  // The machine list says asleep while the relay reports the machine
  // offline, so the notice says the same thing, names the machine, and asks
  // for no command this page could not run on the machine.
  test("a page that reaches its machine through the relay names that machine, and says it is asleep while the relay reports it offline", () => {
    const offline = renderComposerStatus([], undefined, undefined, 0, { machine: "box", offline: true })
    assert.match(offline, /runtime-fault-fault[^>]*>box is asleep or offline\. Wake it, or open Flywheel on it\. Flywheel connects by itself after that\./)
    assert.doesNotMatch(offline, /stopped answering|flywheel kill/)
    const online = renderComposerStatus([], undefined, undefined, 0, { machine: "box", offline: false })
    assert.match(online, /runtime-fault-fault[^>]*>Flywheel on box does not answer\./)
    assert.doesNotMatch(online, /stopped answering|flywheel kill/)
  })
})
