import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack, type ModalContext } from "../../../../src/tui/components/modal-stack.js"
import type { ModuleRowAction } from "../../../../src/protocol/protocol-module.js"
import { statusRows, useStatusModal, type StatusModalHook, type StatusRow } from "../../../../src/tui/hooks/use-status-modal.js"
import type { UpdateAutoInstall, UpdateStatus, UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"

const ROWS: StatusRow[] = [
  { label: "Session", value: "s1 · chat · active", copy: "s1" },
  { label: "Working Directory", value: "/repo" },
  { label: "Debug", value: "flywheel events search --session s1 --errors" },
]
const PAPERCUTS: StatusRow = { label: "Papercuts", value: "3 waiting", action: { kind: "command", id: "papercuts" } }
const AUTO_INSTALL_ON: UpdateAutoInstall = { persisted: true, forcedOff: false, effective: true }
const AUTO_INSTALL_OFF: UpdateAutoInstall = { persisted: false, forcedOff: false, effective: false }

function updateView(autoInstall: UpdateAutoInstall, status: UpdateStatus = { kind: "idle" }): UpdateStatusView {
  return { revision: 1, autoInstall, status }
}

interface Harness {
  readonly hook: StatusModalHook
  readonly modal: ModalContext
  readonly copied: string[]
  readonly toasts: string[]
  readonly activated: ModuleRowAction[]
  readonly sendKey: (name: string) => void
  readonly dispose: () => void
}

function harness(rows: readonly StatusRow[] = ROWS): Harness {
  const copied: string[] = []
  const toasts: string[] = []
  const activated: ModuleRowAction[] = []
  const modal = createModalStack()

  return createRoot((dispose) => {
    const hook = useStatusModal({
      modal,
      renderModal: () => null,
      rows: () => rows,
      copy: async (text) => { copied.push(text) },
      activate: (action) => { activated.push(action) },
      showToast: ({ message }) => { toasts.push(message) },
    })
    return {
      hook,
      modal,
      copied,
      toasts,
      activated,
      sendKey: (name: string) => { modal.input({ name }) },
      dispose,
    }
  })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useStatusModal", () => {
  it("arrows highlight without copying; c copies the highlighted row", async () => {
    const h = harness()
    h.hook.openStatusModal()
    expect(h.hook.statusCursor()).toBe(-1)

    h.sendKey("down")
    await settle()
    expect(h.hook.statusCursor()).toBe(0)
    expect(h.copied).toEqual([])

    h.sendKey("c")
    await settle()
    expect(h.copied).toEqual(["s1"])
    expect(h.toasts).toEqual(["Session copied to clipboard"])
    h.dispose()
  })

  it("c without a highlight is a no-op; up from unhighlighted wraps to the last row", async () => {
    const h = harness()
    h.hook.openStatusModal()

    h.sendKey("c")
    h.sendKey("up")
    expect(h.hook.statusCursor()).toBe(2)
    h.sendKey("down")
    expect(h.hook.statusCursor()).toBe(0)
    h.sendKey("up")
    expect(h.hook.statusCursor()).toBe(2)

    await settle()
    expect(h.copied).toEqual([])
    h.dispose()
  })

  it("enter copies the highlighted row instead of closing; closes when unhighlighted", async () => {
    const h = harness()
    h.hook.openStatusModal()

    h.sendKey("up")
    h.sendKey("return")
    await settle()
    expect(h.copied).toEqual(["flywheel events search --session s1 --errors"])
    expect(h.modal.stack).toHaveLength(1)

    h.hook.openStatusModal()
    h.sendKey("return")
    expect(h.modal.stack).toHaveLength(0)
    h.dispose()
  })

  it("clicking a row highlights it and copies its value when no copy override exists", async () => {
    const h = harness()
    h.hook.openStatusModal()

    h.hook.selectStatusRow(1)
    await settle()
    expect(h.hook.statusCursor()).toBe(1)
    expect(h.copied).toEqual(["/repo"])
    h.dispose()
  })

  it("escape closes and reopening resets the highlight", () => {
    const h = harness()
    h.hook.openStatusModal()
    h.sendKey("down")
    expect(h.hook.statusCursor()).toBe(0)

    h.sendKey("escape")
    expect(h.modal.stack).toHaveLength(0)

    h.hook.openStatusModal()
    expect(h.hook.statusCursor()).toBe(-1)
    h.dispose()
  })

  it("enter and a click on a module row with an action close the modal and run the action instead of copying; c still copies", async () => {
    const h = harness([...ROWS, PAPERCUTS])
    h.hook.openStatusModal()
    h.sendKey("up")
    h.sendKey("return")
    await settle()
    expect(h.activated).toEqual([{ kind: "command", id: "papercuts" }])
    expect(h.copied).toEqual([])
    expect(h.modal.stack).toHaveLength(0)

    h.hook.openStatusModal()
    h.hook.selectStatusRow(3)
    await settle()
    expect(h.activated).toHaveLength(2)
    expect(h.modal.stack).toHaveLength(0)

    h.hook.openStatusModal()
    h.sendKey("up")
    h.sendKey("c")
    await settle()
    expect(h.copied).toEqual(["3 waiting"])
    expect(h.modal.stack).toHaveLength(1)
    h.dispose()
  })

  it("finishes a copy started by a closed modal but drops its feedback", async () => {
    const h = harness()
    h.hook.openStatusModal()
    h.sendKey("down")
    h.sendKey("c")
    h.modal.replace("newer-modal")

    await settle()
    expect(h.copied).toEqual(["s1"])
    expect(h.toasts).toEqual([])
    h.dispose()
  })
})

describe("statusRows", () => {
  it("copies only the session id from the Session row and includes the debug incantation", () => {
    const rows = statusRows({
      sessionId: "abc123",
      sessionKind: "chat",
      sessionState: "active",
      modelLabel: "claude",
      activeSessionCount: 1,
      sessionCount: 3,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: "/repo",
      update: updateView(AUTO_INSTALL_ON),
    })
    const session = rows.find((row) => row.label === "Session")
    expect(session?.copy).toBe("abc123")
    expect(session?.value).toContain("chat · active")
    expect(rows.find((row) => row.label === "Debug")?.value).toBe("flywheel events search --session abc123 --errors")
  })

  it("omits the Debug row and session copy when no session is foreground", () => {
    const rows = statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: updateView(AUTO_INSTALL_ON),
    })
    expect(rows.find((row) => row.label === "Session")?.value).toBe("none")
    expect(rows.find((row) => row.label === "Session")?.copy).toBeUndefined()
    expect(rows.some((row) => row.label === "Debug")).toBe(false)
  })

  it("labels the known cost subtotal when pricing is unavailable", () => {
    const rows = statusRows({
      sessionId: "abc123",
      sessionKind: "chat",
      sessionState: "active",
      budget: { totalsLoading: false, tokens: 100, cost: 1.25, billedCost: 0.5, priceUnavailable: true, contextPercent: 10, contextPromptTokens: 50 },
      activeSessionCount: 1,
      sessionCount: 1,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: "/repo",
      update: updateView(AUTO_INSTALL_ON),
    })

    expect(rows.find((row) => row.label === "Usage")?.value).toBe("100 tokens · $0.50 · ~$0.75 · price unavailable")
  })

  it("replaces every aggregate statistic while totals load", () => {
    const rows = statusRows({
      sessionId: "abc123",
      sessionKind: "chat",
      sessionState: "inactive",
      budget: { totalsLoading: true },
      activeSessionCount: 0,
      sessionCount: 1,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: "/repo",
      update: undefined,
    })

    expect(rows.find((row) => row.label === "Context")?.value).toBe("totals loading")
    expect(rows.find((row) => row.label === "Usage")?.value).toBe("totals loading")
  })

  it("labels project identity and session execution directory as separate rows", () => {
    const rows = statusRows({
      sessionId: "abc123",
      sessionKind: "chat",
      sessionState: "active",
      activeSessionCount: 1,
      sessionCount: 1,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: "/repo/packages/pkg",
      update: updateView(AUTO_INSTALL_OFF),
    })
    expect(rows.find((row) => row.label === "Project Root")?.value).toBe("/repo")
    expect(rows.find((row) => row.label === "Working Directory")?.value).toBe("/repo/packages/pkg")
  })

  it("keeps project identity and invents no working directory when no session is selected", () => {
    const rows = statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: updateView(AUTO_INSTALL_OFF),
    })
    expect(rows.find((row) => row.label === "Project Root")?.value).toBe("/repo")
    expect(rows.some((row) => row.label === "Working Directory")).toBe(false)
  })

  it("reports the update policy immediately after Version", () => {
    const rows = statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: updateView(AUTO_INSTALL_ON),
    })
    const versionIndex = rows.findIndex((row) => row.label === "Version")
    expect(rows[versionIndex + 1]).toEqual({ label: "Updates", value: "Automatic updates on" })
  })

  // A row that reported the durable value alone would contradict what the
  // runtime is actually doing for the rest of this run.
  it("names the environment override rather than the durable value it holds off", () => {
    const rows = statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: updateView({ persisted: true, forcedOff: true, effective: false }),
    })
    expect(rows.find((row) => row.label === "Updates")?.value).toBe("Automatic updates on, held off for this run")
  })

  it("reports a disabled update policy", () => {
    const rows = statusRows({
      sessionId: "abc123",
      sessionKind: "chat",
      sessionState: "active",
      activeSessionCount: 1,
      sessionCount: 1,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: "/repo",
      update: updateView(AUTO_INSTALL_OFF),
    })
    expect(rows.find((row) => row.label === "Updates")?.value).toBe("Automatic updates off")
    const updatesIndex = rows.findIndex((row) => row.label === "Updates")
    expect(rows[updatesIndex - 1]?.label).toBe("Version")
  })

  // After a rollback the account runs an older release, so the row names the
  // release that could not start before the policy. The composer border stays
  // quiet about it, so this row is where the terminal says it.
  it("names a release that could not start on this machine before the policy, and only that state", () => {
    const updates = (status: UpdateStatus) => statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: updateView(AUTO_INSTALL_ON, status),
    }).find((row) => row.label === "Updates")?.value
    expect(updates({ kind: "refused", version: "1.4.0" })).toBe("1.4.0 could not start on this machine · Automatic updates on")
    expect(updates({ kind: "idle" })).toBe("Automatic updates on")
    expect(updates({ kind: "available", version: "1.4.0", blocking: "nothing" })).toBe("Automatic updates on")
    expect(updates({ kind: "installing", version: "1.4.0" })).toBe("Automatic updates on")
    expect(updates({ kind: "installed", version: "1.4.0" })).toBe("Automatic updates on")
    // No policy applies to a build that never updates, so the row names only that.
    expect(updates({ kind: "no-repository" })).toBe("updates off: this build names no release repository")
  })

  it("omits the Updates row until the runtime publishes its policy", () => {
    const rows = statusRows({
      sessionKind: null,
      sessionState: null,
      activeSessionCount: 0,
      sessionCount: 0,
      appVersion: "1.0.0",
      projectRoot: "/repo",
      executionCwd: null,
      update: undefined,
    })
    expect(rows.some((row) => row.label === "Updates")).toBe(false)
  })
})
