import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { mcpDomain, type McpStatusRow } from "../../../../../src/protocol/modules/mcp.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { createMcpList } from "../../../../../src/tui/modules/mcp/list.js"
import { runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"
import type { FrontendMutation } from "../../../../../src/protocol/app-service-types.js"

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })
const needsAuth: McpStatusRow = { name: "work", status: "needs_auth", toolCount: 0, definitionScope: "global", enabledScope: "global", enabled: true, hasGlobalFallback: false, expected: "reviewed" }
type Answer = { readonly ok: true; readonly warning?: string } | { readonly ok: false; readonly error: string }
function harness(initial: readonly McpStatusRow[] = [needsAuth], answer: () => Promise<Answer> = async () => ({ ok: true })) {
  const [rows, setRows] = createSignal(initial)
  const commands: unknown[] = []
  const toasts: unknown[] = []
  let closed = 0
  const read = moduleDomainReader((domain) => domain.domain === mcpDomain.domain ? rows() : undefined)
  const answered = (command: FrontendMutation) => { commands.push(command); return answer() }
  const dispatch = runtimeDispatch({ "mcp.authenticate": answered, "mcp.reconnect": answered, "mcp.setEnabled": answered, "mcp.setClient": answered, "mcp.remove": answered })
  const list = createRoot((dispose) => { disposers.push(dispose); return createMcpList({ read, client: { dispatch }, showToast: (toast) => { toasts.push(toast) }, close: () => { closed++ } }) })
  return { list, commands, toasts, rows: setRows, closed: () => closed }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe("the MCP surface list", () => {
  test("shares membership work across row bindings after publication and navigation", () => {
    for (const count of [20, 40, 80]) {
      let nameReads = 0
      const rows = Array.from({ length: count }, (_, index) => ({
        ...needsAuth,
        get name() { nameReads++; return `server-${index}` },
      }))
      const h = harness(rows)
      h.list.select(count - 1)
      const revision = h.list.navigationRevision()
      nameReads = 0
      h.rows([...rows])
      for (let index = 0; index < count; index++) {
        expect(h.list.cursor() === index).toBe(index === count - 1)
        expect(h.list.cursor() === index).toBe(index === count - 1)
      }
      expect(nameReads).toBeLessThanOrEqual(count * 2)
      expect(h.list.navigationRevision()).toBe(revision)
      nameReads = 0
      h.list.select(0)
      for (let index = 0; index < count; index++) {
        expect(h.list.cursor() === index).toBe(index === 0)
        expect(h.list.cursor() === index).toBe(index === 0)
      }
      expect(nameReads).toBeLessThanOrEqual(count * 2)
      expect(h.list.navigationRevision()).toBe(revision + 1)
    }
  })
  test("dispatches one authentication until settlement and reports failures and success", async () => {
    const result = Promise.withResolvers<Answer>()
    const h = harness(undefined, () => result.promise)
    h.list.repair(); h.list.repair()
    expect(h.commands).toEqual([{ type: "mcp.authenticate", server: "work" }])
    expect(h.list.pending()).toContain("Authenticating")
    result.resolve({ ok: false, error: "MCP authentication failed. Try again." })
    await settle()
    expect(h.toasts).toEqual([{ message: "MCP authentication failed. Try again.", variant: "error" }])
    expect(h.list.pending()).toBeUndefined()
    const success = harness()
    success.list.repair()
    await settle()
    expect(success.toasts).toEqual([{ message: "work authenticated", variant: "success" }])
  })
  test("Enter and r reconnect a failed row and report its connection; r ignores other rows", async () => {
    const h = harness([{ ...needsAuth, status: "failed", error: "Connection failed" }])
    h.list.key({ name: "enter" })
    expect(h.commands).toEqual([{ type: "mcp.reconnect", server: "work" }])
    expect(h.list.pending()).toBe("Reconnecting work...")
    await settle()
    expect(h.toasts).toEqual([{ message: "work connected", variant: "success" }])
    h.list.key({ name: "r" })
    expect(h.commands).toEqual([{ type: "mcp.reconnect", server: "work" }, { type: "mcp.reconnect", server: "work" }])
    const authentication = harness()
    authentication.list.key({ name: "r" })
    expect(authentication.commands).toEqual([])
  })
  test("wraps arrows and j/k, clamps removed rows, ignores ineligible authentication and closes", () => {
    const h = harness([{ ...needsAuth, name: "first", status: "ready" }, needsAuth])
    h.list.repair()
    expect(h.commands).toEqual([])
    h.list.key({ name: "down" }); expect(h.list.cursor()).toBe(1)
    h.list.key({ name: "j" }); expect(h.list.cursor()).toBe(0)
    h.list.key({ name: "k" }); expect(h.list.cursor()).toBe(1)
    h.rows([{ ...needsAuth, name: "new" }, { ...needsAuth, name: "first", status: "ready" }, needsAuth])
    expect(h.list.selected()?.name).toBe("work")
    expect(h.list.cursor()).toBe(2)
    h.rows([needsAuth]); expect(h.list.cursor()).toBe(0)
    h.list.key({ name: "escape" }); expect(h.closed()).toBe(1)
    h.list.key({ name: "q" }); expect(h.closed()).toBe(2)
    expect(h.list.key({ name: "x" })).toBe(false)
  })
  test("requires explicit Cancel-first confirmation and retains reviewed definition scope and token", async () => {
    const h = harness([{ ...needsAuth, enabledScope: "project" }])
    h.list.key({ name: "d" })
    expect(h.commands).toEqual([])
    expect(h.list.review()?.focus).toBe(0)
    h.list.key({ name: "left" })
    expect(h.list.review()?.focus).toBe(1)
    h.list.key({ name: "tab" })
    expect(h.list.review()?.focus).toBe(0)
    h.list.key({ name: "enter" })
    expect(h.list.review()).toBeUndefined()
    h.list.remove()
    h.list.key({ name: "escape" })
    expect(h.commands).toEqual([])
    h.list.remove()
    h.rows([{ ...needsAuth, name: "new", expected: "new-token" }])
    h.list.key({ name: "right" })
    h.list.key({ name: "enter" })
    h.list.key({ name: "d" }); h.list.key({ name: "q" }); h.list.confirm()
    expect(h.closed()).toBe(1)
    expect(h.commands).toEqual([{ type: "mcp.remove", server: "work", scope: "global", expected: "reviewed" }])
    await settle()
    expect(h.list.pending()).toBeUndefined()
    const local = harness([{ ...needsAuth, definitionScope: "project", enabledScope: "project", hasGlobalFallback: true }])
    local.list.remove()
    local.list.confirm()
    expect(local.commands).toEqual([{ type: "mcp.remove", server: "work", scope: "project", expected: "reviewed" }])
  })
  test("keyboard and pointer enabled actions share exact requests, including project overrides and disabled rows", async () => {
    for (const keyboard of [false, true]) {
      const h = harness()
      if (keyboard) h.list.key({ name: "p" }); else h.list.setEnabled(true)
      expect(h.commands).toEqual([{ type: "mcp.setEnabled", server: "work", scope: "project", enabled: false, expected: "reviewed" }])
      await settle()
      h.rows([{ ...needsAuth, enabledScope: "project", enabled: false, status: "disabled" }])
      if (keyboard) h.list.key({ name: "e" }); else h.list.setEnabled()
      expect(h.commands.at(-1)).toEqual({ type: "mcp.setEnabled", server: "work", scope: "project", enabled: true, expected: "reviewed" })
    }
  })
  test("c switches the client of an HTTP server in its defining scope and does nothing for a stdio server", async () => {
    const h = harness([{ ...needsAuth, definitionScope: "project", enabledScope: "project", client: { kind: "claude", source: "built-in", service: "Slack", reason: "Slack only accepts approved apps" } }])
    h.list.key({ name: "c" })
    expect(h.commands).toEqual([{ type: "mcp.setClient", server: "work", scope: "project", client: "flywheel", expected: "reviewed" }])
    await settle()
    expect(h.toasts).toEqual([{ message: "work uses Flywheel as client", variant: "success" }])
    h.rows([{ ...needsAuth, client: { kind: "flywheel" } }])
    h.list.key({ name: "c" })
    expect(h.commands.at(-1)).toEqual({ type: "mcp.setClient", server: "work", scope: "global", client: "claude", expected: "reviewed" })
    const stdio = harness()
    stdio.list.key({ name: "c" })
    expect(stdio.commands).toEqual([])
  })
  test("reports saved warnings, unverifiable rejection and thrown failure without reviving disposed openings", async () => {
    for (const answer of [
      async (): Promise<Answer> => ({ ok: true, warning: "Saved, but application degraded." }),
      async (): Promise<Answer> => ({ ok: false, error: "Saving could not be verified." }),
      async (): Promise<Answer> => { throw new Error("private error") },
    ]) {
      const h = harness(undefined, answer)
      h.list.setEnabled()
      await settle()
      expect(h.list.pending()).toBeUndefined()
      expect(h.toasts).toHaveLength(1)
      expect(JSON.stringify(h.toasts)).not.toContain("private error")
    }
    const completion = Promise.withResolvers<Answer>()
    const old = harness(undefined, () => completion.promise)
    old.list.repair()
    for (const dispose of disposers.splice(0)) dispose()
    const fresh = harness()
    expect(fresh.list.cursor()).toBe(0)
    expect(fresh.list.review()).toBeUndefined()
    completion.resolve({ ok: true })
    await settle()
    expect(old.toasts).toEqual([])
    expect(fresh.list.pending()).toBeUndefined()
  })
})
