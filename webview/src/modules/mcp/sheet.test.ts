import assert from "node:assert/strict"
import { test } from "node:test"
import { actionOwner } from "../../app/action-owner-fixture.js"
import { createMcpMutation } from "./mutation.js"
import { mcpEnabledAction, type McpStatusRow } from "../../../../src/protocol/modules/mcp.js"
import type { ConfirmRequest } from "../../app/client-context.js"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-fixture.ts", import.meta.url))], target: "bun", format: "esm",
  plugins: [{ name: "solid-ssr", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
const { renderMcpSheet }: typeof import("./sheet-fixture.js") = await importBuiltModule(javascript)

const row: McpStatusRow = { name: "server", status: "needs_auth", toolCount: 0, definitionScope: "global", enabledScope: "project", enabled: true, hasGlobalFallback: false, expected: "reviewed" }

test("Remove reviews Cancel-first before dispatch and shares one server action owner", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  const requests: ConfirmRequest[] = []
  const dispatched: unknown[] = []
  const signal = new AbortController()
  const operation = createMcpMutation({
    actions: actionOwner(), report: () => {},
    confirm: async (request, received) => { requests.push(request); assert.equal(received, signal.signal); return confirmation.promise },
    dispatch: async (mutation) => { dispatched.push(mutation); return { ok: true } },
  }, () => true, signal.signal)
  const removing = operation.remove(row)
  void operation.remove(row)
  void operation.enabled(row, mcpEnabledAction(row))
  void operation.authenticate(row)
  assert.equal(operation.working(row.name), true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.cancelByDefault, true)
  assert.equal(requests[0]?.destructive, true)
  assert.match(requests[0]?.detail ?? "", /All projects|all projects/)
  assert.equal(dispatched.length, 0)
  confirmation.resolve(true)
  await removing
  assert.deepEqual(dispatched, [{ type: "mcp.remove", server: "server", scope: "global", expected: "reviewed" }])
  assert.equal(operation.working(row.name), false)
})

test("cancel, aborted sheet, and project departure refuse delayed removal", async () => {
  for (const reason of ["cancel", "abort", "depart", "escape"]) {
    const deferred = Promise.withResolvers<boolean>()
    const controller = new AbortController()
    let active = true
    const dispatched: unknown[] = []
    const operation = createMcpMutation({
      actions: actionOwner(), report: () => {},
      confirm: () => deferred.promise,
      dispatch: async (mutation) => { dispatched.push(mutation); return { ok: true } },
    }, () => active, controller.signal)
    const removing = operation.remove(row)
    if (reason === "abort") controller.abort()
    if (reason === "depart") active = false
    if (reason === "escape") deferred.reject(new Error("closed"))
    else deferred.resolve(reason !== "cancel")
    await removing
    assert.deepEqual(dispatched, [])
    assert.equal(operation.working(row.name), false)
  }
})

test("enabled uses exact project override and disabled definition requests and reports saved warnings", async () => {
  const dispatched: unknown[] = []
  const reports: string[] = []
  const operation = createMcpMutation({
    actions: actionOwner(), confirm: async () => true,
    report: (_severity, message) => reports.push(message),
    dispatch: async (mutation) => { dispatched.push(mutation); return { ok: true, warning: "MCP settings were saved, but connections could not fully update. Check their status." } },
  }, () => true, new AbortController().signal)
  await operation.enabled(row, mcpEnabledAction(row))
  assert.deepEqual(dispatched, [{ type: "mcp.setEnabled", server: "server", scope: "project", enabled: false, expected: "reviewed" }])
  assert.match(reports[0] ?? "", /saved, but/)
  assert.equal(operation.working(row.name), false)
  const disabled = { ...row, definitionScope: "project", enabled: false } as const
  await operation.enabled(disabled, mcpEnabledAction(disabled))
  assert.deepEqual(dispatched[1], { type: "mcp.setEnabled", server: "server", scope: "project", enabled: true, expected: "reviewed" })
})

test("scoped native controls render without interactive row wrappers or private configuration", () => {
  for (const missing of [undefined, null]) {
    const loading = renderMcpSheet(missing)
    assert.match(loading, /aria-busy="true">Reading/)
    assert.doesNotMatch(loading, /No MCP servers configured/)
  }
  assert.match(renderMcpSheet([]), /No MCP servers configured/)
  const html = renderMcpSheet([
    row,
    { ...row, name: "inherited", status: "ready", enabledScope: "global" },
    { ...row, name: "local", status: "disabled", definitionScope: "project", enabled: false, hasGlobalFallback: true },
    { ...row, name: "failed", status: "failed", error: "Connection failed" },
  ])
  assert.match(html, /Authenticate/)
  assert.match(html, /Disable in this project/)
  assert.match(html, /Enable/)
  assert.match(html, /Project/)
  assert.match(html, /Global/)
  assert.match(html, /Connection failed/)
  assert.equal((html.match(/>Remove<\/button>/g) ?? []).length, 4)
  assert.doesNotMatch(html, /role="button"|sheet-row-button|https?:|Authorization|\/repo/)
  assert.match(renderMcpSheet([]), /No MCP servers configured/)
  const busy = renderMcpSheet([row, { ...row, name: "other", status: "ready" }], row.name)
  assert.equal((busy.match(/aria-busy="true"/g) ?? []).length, 1)
  assert.match(busy, /Working/)
})

test("different rows remain usable and refused or thrown mutations settle safely", async () => {
  const pending = Promise.withResolvers<{ readonly ok: false; readonly error: string }>()
  const reports: string[] = []
  const requests: unknown[] = []
  const operation = createMcpMutation({
    actions: actionOwner(), confirm: async () => true,
    report: (_severity, message) => reports.push(message),
    dispatch: async (mutation) => {
      requests.push(mutation)
      if (mutation.server === row.name) return pending.promise
      throw new Error("private transport details")
    },
  }, () => true, new AbortController().signal)
  const first = operation.enabled(row, mcpEnabledAction(row))
  await operation.authenticate({ ...row, name: "other" })
  assert.equal(requests.length, 2)
  assert.equal(operation.working(row.name), true)
  assert.equal(operation.working("other"), false)
  pending.resolve({ ok: false, error: "Saving could not be verified. Check MCP settings before trying again." })
  await first
  assert.match(reports[1] ?? "", /could not be verified/)
  assert.doesNotMatch(reports.join(" "), /private transport/)
  assert.equal(operation.working(row.name), false)
})

test("project Remove explains fallback and preserved credentials; authentication stays explicit", async () => {
  const reports: string[] = []
  const dispatched: unknown[] = []
  const operation = createMcpMutation({
    actions: actionOwner(),
    report: (_severity, message) => reports.push(message),
    confirm: async (request) => {
      assert.match(request.title, /project/)
      assert.match(request.detail ?? "", /inherited global/)
      assert.match(request.detail ?? "", /credentials.*kept|credentials.*retain/i)
      return true
    },
    dispatch: async (mutation) => { dispatched.push(mutation); return { ok: true } },
  }, () => true, new AbortController().signal)
  await operation.remove({ ...row, definitionScope: "project", hasGlobalFallback: true })
  await operation.authenticate(row)
  assert.deepEqual(dispatched, [
    { type: "mcp.remove", server: "server", scope: "project", expected: "reviewed" },
    { type: "mcp.authenticate", server: "server" },
  ])
  assert.deepEqual(reports, ["server authenticated."])
})
