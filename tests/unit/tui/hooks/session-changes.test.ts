import { expect, it, spyOn } from "bun:test"
import { buildCommandDefinitions } from "../../../../src/tui/commands/command-definitions.js"
import { publishedCommands } from "../../../helpers/command-catalog.js"
import { createRoot, createSignal } from "solid-js"
import { createSessionChangesIntake, startSessionChangesWhenReady } from "../../../../src/tui/hooks/create-session-changes.js"
import { useSessionChangesModal } from "../../../../src/tui/hooks/use-session-changes-modal.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { sessionChangePathLabel, sessionChangesLabel, sessionChangesPromptLabel, undoResultLine } from "../../../../src/protocol/client/session-changes-copy.js"
import { deferred, fileA, fileB, fileC, retainedDiff, runtime, settle, waitForDiff } from "../../protocol/client/_session-changes-fixtures.js"
import type { SessionChangeDiffResult, SessionChangeSummaryResult } from "../../../../src/protocol/session-changes-protocol-types.js"

it("offers Changes as a per-file review without a keyboard override", () => {
  const command = buildCommandDefinitions(() => "", publishedCommands()).find(item => item.spec.id === "changes")
  expect(command?.spec).toEqual({ id: "changes", title: "Changes", description: "Review the file changes of this session and the agents it launched, and undo them per file" })
})

it("uses the last known count or plain Changes for all summary states", () => {
  const data = { snapshotPosition: 1, fileCount: 2, unknownFileMutationGaps: 0 }
  expect(sessionChangesLabel(undefined)).toBe("Changes")
  expect(sessionChangesLabel({ status: "idle" })).toBe("Changes")
  for (const status of ["loading", "stale"] as const) {
    expect(sessionChangesLabel({ status })).toBe("Changes")
    expect(sessionChangesLabel({ status, data })).toBe("Changes (2)")
  }
  expect(sessionChangesLabel({ status: "error", error: "offline" })).toBe("Changes")
  expect(sessionChangesLabel({ status: "error", error: "offline", data })).toBe("Changes (2)")
  expect(sessionChangesLabel({ status: "ready", data: { ...data, fileCount: 0 } })).toBe("Changes (0)")
  expect(sessionChangesLabel({ status: "incomplete", data: { ...data, unknownFileMutationGaps: 1 } })).toBe("Changes (2+)")
})

it("shows the prompt Changes control only for a positive last known count", () => {
  const data = { snapshotPosition: 1, fileCount: 2, unknownFileMutationGaps: 0 }
  expect(sessionChangesPromptLabel(undefined)).toBeUndefined()
  expect(sessionChangesPromptLabel({ status: "idle" })).toBeUndefined()
  expect(sessionChangesPromptLabel({ status: "ready", data: { ...data, fileCount: 0 } })).toBeUndefined()
  expect(sessionChangesPromptLabel({ status: "stale", data })).toBe("Changes (2)")
  expect(sessionChangesPromptLabel({ status: "incomplete", data: { ...data, unknownFileMutationGaps: 1 } })).toBe("Changes (2+)")
})

it("labels paths relative to the project root only inside it and states every Undo outcome in one line", () => {
  expect(sessionChangePathLabel("/work/src/a.txt", "/work")).toBe("src/a.txt")
  expect(sessionChangePathLabel("/work/src/a.txt", "/work/")).toBe("src/a.txt")
  expect(sessionChangePathLabel("/elsewhere/a.txt", "/work")).toBe("/elsewhere/a.txt")
  expect(sessionChangePathLabel("/workshop/a.txt", "/work")).toBe("/workshop/a.txt")
  expect(sessionChangePathLabel("/work", "/work")).toBe("/work")
  expect(sessionChangePathLabel("/work/../outside.txt", "/work")).toBe("/work/../outside.txt")
  expect(sessionChangePathLabel("C:\\Work\\src\\a.txt", "c:\\work")).toBe("src\\a.txt")
  expect(undoResultLine({ status: "completed" })).toBe("Undo completed")
  expect(undoResultLine({ status: "refused", message: "Changes have moved on" })).toBe("Undo refused: Changes have moved on")
  expect(undoResultLine({ status: "uncertain", message: "lost receipt" })).toBe("Undo uncertain: lost receipt")
})

function harness() {
  const server = runtime()
  const owner = createRoot(dispose => {
    const [foregroundId, setForeground] = createSignal<string | undefined>("cold")
    const intake = createSessionChangesIntake({ client: server.client, foregroundId })
    const modal = createModalStack()
    const controls = useSessionChangesModal({ modal, view: intake.view, renderModal: () => undefined })
    return { dispose, intake, modal, controls, setForeground }
  })
  return { server, ...owner }
}

function startupHarness(initialPhase: string | null = "loading") {
  const server = runtime()
  const owner = createRoot(dispose => {
    const [firstFrame, setFirstFrame] = createSignal(false)
    const [startupPhase, setStartupPhase] = createSignal<string | null>(initialPhase)
    const [foregroundId] = createSignal<string | undefined>("cold")
    const intake = createSessionChangesIntake({ client: server.client, foregroundId })
    startSessionChangesWhenReady(
      () => firstFrame() && startupPhase() === null,
      intake.start,
    )
    return { dispose, setFirstFrame, setStartupPhase }
  })
  return { server, ...owner }
}

const waitForTimer = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A diff that adds `lines` numbered lines to an empty file. */
function addedLines(path: string, lines: number): SessionChangeDiffResult {
  const body = Array.from({ length: lines }, (_, index) => `+line ${index + 1}`).join("\n")
  return retainedDiff(path, `--- a${path}\n+++ b${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`, lines)
}

async function renderModal(h: ReturnType<typeof harness>) {
  const [{ testRender }, { createComponent }, { ThemeProvider, useTheme }, { SessionChangesModal }] = await Promise.all([
    import("@opentui/solid"), import("solid-js/web"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/modals/session-changes-modal.js"),
  ])
  let theme: ReturnType<typeof useTheme>["theme"] | undefined
  function Capture() {
    theme = useTheme().theme
    return createComponent(SessionChangesModal, {
      get view() { return h.intake.view() }, controls: h.controls, projectRoot: "/work", diffColors: () => "theme",
    })
  }
  const rendered = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(Capture, {}) } }), { width: 120, height: 50 })
  await rendered.renderOnce()
  await settle()
  await rendered.renderOnce()
  if (!theme) throw new Error("Theme was not provided")
  const frame = () => rendered.captureCharFrame()
  const span = (text: string) => {
    for (const line of rendered.captureSpans().lines) {
      const found = line.spans.find(item => item.text.includes(text))
      if (found) return found
    }
    throw new Error(`${text} was not rendered`)
  }
  return { rendered, theme, frame, span, render: () => rendered.renderOnce() }
}

async function renderDiff(h: ReturnType<typeof harness>, view: Awaited<ReturnType<typeof renderModal>>, fileId: string, revision?: number): Promise<void> {
  const controller = h.intake.view()?.controller
  if (!controller) throw new Error("Expected an open changes controller")
  await waitForDiff(controller, fileId, revision)
  await view.render()
}

it("starts Session Changes only after stable post-frame readiness", async () => {
  const interrupted = startupHarness(null)
  interrupted.setFirstFrame(true)
  interrupted.setStartupPhase("connecting")
  await waitForTimer()
  expect(interrupted.server.queries).toHaveLength(0)
  interrupted.setStartupPhase(null)
  await waitForTimer()
  await settle()
  expect(interrupted.server.queries.filter(query => query.type === "sessionChangeSummary")).toHaveLength(1)
  interrupted.dispose()

  const phaseBeforeFrame = startupHarness()
  phaseBeforeFrame.setStartupPhase(null)
  await waitForTimer()
  expect(phaseBeforeFrame.server.queries).toHaveLength(0)
  phaseBeforeFrame.setFirstFrame(true)
  await waitForTimer()
  await settle()
  expect(phaseBeforeFrame.server.queries.filter(query => query.type === "sessionChangeSummary")).toHaveLength(1)
  phaseBeforeFrame.dispose()

  const readyBeforeFrame = startupHarness(null)
  await waitForTimer()
  expect(readyBeforeFrame.server.queries).toHaveLength(0)
  readyBeforeFrame.setFirstFrame(true)
  readyBeforeFrame.dispose()
  await waitForTimer()
  expect(readyBeforeFrame.server.queries).toHaveLength(0)
})

it("defers acquisition, follows the current session, rejects old reads and disposes subscriptions", async () => {
  const h = harness()
  try {
    expect(h.server.queries).toHaveLength(0)
    expect(h.server.subscribers).toBe(1)
    h.intake.start()
    await settle()
    expect(sessionChangesLabel(h.intake.view()?.snapshot().summary)).toBe("Changes (2)")
    const pending = deferred<SessionChangeSummaryResult>()
    h.server.summaryReplies.push(pending.promise)
    h.server.change()
    await settle()
    h.server.current.fileCount = 3
    h.setForeground("other")
    await settle()
    expect(h.intake.view()?.controller.sessionId).toBe("other")
    expect(sessionChangesLabel(h.intake.view()?.snapshot().summary)).toBe("Changes (3)")
    expect(h.server.subscribers).toBe(2)
    pending.resolve({ snapshotPosition: 99, fileCount: 99, unknownFileMutationGaps: 0 })
    await settle()
    expect(sessionChangesLabel(h.intake.view()?.snapshot().summary)).toBe("Changes (3)")
    h.server.emit({ type: "patch", patch: { cursor: { scope: "session", sessionId: "other", domain: "session" }, position: 2, prevPosition: 1, payload: { kind: "session.removed" } } })
    expect(h.intake.view()).toBeUndefined()
  } finally { h.dispose() }
  expect(h.server.subscribers).toBe(0)
  expect(h.server.closed).toBe(false)
})

it("renders one styled header per file with a collapsed net diff that Enter expands in place", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.server.diffReplies.push(Promise.resolve(addedLines(fileA.path, 30)))
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    const { theme, frame, span } = view
    expect(frame()).toContain("> a.txt")
    expect(frame()).toContain("  b.txt")
    expect(frame()).not.toContain("/work/a.txt")
    expect(span("a.txt").fg.equals(theme.primary)).toBe(true)
    expect(span("a.txt").bg.equals(theme.backgroundRaised)).toBe(true)
    expect(span("b.txt").fg.equals(theme.text)).toBe(true)
    expect(span("b.txt").bg.equals(theme.backgroundRaised)).toBe(true)
    expect(span("modified").fg.equals(theme.warning)).toBe(true)
    expect(span("added").fg.equals(theme.diffAdded)).toBe(true)
    // A file that launched agents changed names them in the agent-name color; the chat's own file names nobody.
    expect(frame()).toContain("by Explorer, Reviewer +1")
    expect(span("by Explorer, Reviewer +1").fg.equals(theme.agentName)).toBe(true)
    expect(span("by Explorer, Reviewer +1").bg.equals(theme.backgroundRaised)).toBe(true)
    expect(frame().match(/ by /g)).toHaveLength(1)
    expect(frame().match(/ Undo u /g)).toHaveLength(2)
    expect(frame()).toContain("line 20")
    expect(frame()).not.toContain("line 21")
    expect(frame()).toContain("+10 lines (click to expand)")
    expect(frame()).toContain("Up/Down file | Enter expand | v Viewed | u Undo | PgUp/PgDn scroll | Esc close")
    h.modal.input({ name: "return" })
    await view.render()
    expect(frame()).toContain("line 30")
    expect(frame()).toContain("(click to collapse)")
    h.modal.input({ name: "return" })
    await view.render()
    expect(frame()).not.toContain("line 21")
    h.modal.input({ name: "escape" })
    expect(h.modal.stack).toHaveLength(0)
    expect(h.intake.view()?.snapshot().list.status).toBe("idle")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("groups deleted files under their removed folder across pages, and Enter on the folder shows each file with its own controls", async () => {
  const h = harness()
  const inFolder = (name: string) => ({ ...fileC, fileId: `file:dl:${name}`, path: `/work/dl/${name}`, folder: { path: "/work/dl", files: 2 } })
  Object.assign(h.server.current, { files: [fileA, inFolder("x.bin"), inFolder("y.txt"), { ...fileC, path: "/work/kept/c.txt" }], fileCount: 4, pageSize: 2 })
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  const view = await renderModal(h)
  const redraw = async () => { await settle(); await view.render() }
  try {
    await h.intake.view()!.controller.loadMoreFiles()
    await redraw()
    expect(h.controls.rows().map(row => row.key)).toEqual([fileA.fileId, "folder:/work/dl", fileC.fileId])
    expect([view.frame().includes("dl/ (2 files)"), view.frame().includes("dl/x.bin"), view.frame().match(/ Undo u /g)?.length]).toEqual([true, false, 2])
    h.modal.input({ name: "down" })
    h.modal.input({ name: "return" })
    await redraw()
    expect(h.controls.rows().map(row => row.key)).toEqual([fileA.fileId, "folder:/work/dl", "file:dl:x.bin", "file:dl:y.txt", fileC.fileId])
    expect([view.frame().includes("dl/x.bin"), view.frame().includes("dl/y.txt"), view.frame().match(/ Undo u /g)?.length]).toEqual([true, true, 4])
    Object.assign(h.server.current, { revision: 9, files: h.server.current.files.map(file => file.folder ? { ...file, folder: { ...file.folder, files: 3 } } : file) })
    h.server.change()
    expect(await redraw().then(() => view.frame())).toContain("dl/ (3 files)")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("continues metadata near the cursor and keeps its path through a paged refresh", async () => {
  const h = harness()
  h.server.current.files = Array.from({ length: 60 }, (_, index) => ({
    ...fileA, fileId: `file:${index}`, path: `/work/${String(index).padStart(3, "0")}.txt`,
  }))
  h.server.current.pageSize = 20
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  try {
    expect(h.controls.rows()).toHaveLength(20)
    h.controls.setCursor(19)
    await settle()
    expect(h.controls.rows()).toHaveLength(40)
    h.controls.setCursor(39)
    await settle()
    expect(h.controls.rows()).toHaveLength(60)
    expect(h.controls.cursor()).toBe(39)
    const selected = h.controls.rows()[39]!
    await h.intake.view()!.controller.refresh()
    await settle()
    expect(h.controls.rows()).toHaveLength(60)
    expect(h.controls.rows()[h.controls.cursor()]?.key).toBe(selected.key)
    expect(h.server.queries.filter(query => query.type === "sessionChangeDiff").length).toBeLessThan(10)
  } finally {
    h.dispose()
  }
})

it("states drifted, unretained and loading diffs under their headers and disables Undo for them", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.server.current.files = [fileA, fileB, fileC]
  const pending = deferred<SessionChangeDiffResult>()
  h.server.diffReplies.push(
    Promise.resolve({ status: "unavailable", revision: 7, reason: "drifted" }),
    Promise.resolve({ status: "unavailable", revision: 7, reason: "unretained" }),
    pending.promise,
  )
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    const { theme, frame } = view
    expect(frame()).toContain("Changed outside this session since its last recorded write; Undo unavailable")
    expect(frame()).toContain("Diff not retained; Undo unavailable")
    expect(frame()).toContain("Loading...")
    const undoButtons = view.rendered.captureSpans().lines.flatMap(line => line.spans.filter(span => /^\s*Undo(\s+u)?\s*$/.test(span.text)))
    expect(undoButtons).toHaveLength(3)
    for (const button of undoButtons) expect(button.fg.equals(theme.textMuted)).toBe(true)
    h.modal.input({ name: "u" })
    expect(h.intake.view()?.snapshot().undo).toBeUndefined()
    pending.resolve(addedLines(fileC.path, 2))
    await waitForDiff(h.intake.view()!.controller, fileC.fileId)
    await view.render()
    expect(frame()).toContain("line 2")
    expect(frame()).not.toContain("Loading...")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it.each(["unavailable", "evidence"] as const)("confirms Undo for the cursor file and holds %s proof without losing Cancel", async proof => {
  const h = harness()
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    const { frame } = view
    h.modal.input({ name: "u" })
    await view.render()
    expect(frame()).toContain("Undo all changes to a.txt?")
    expect(frame()).toContain(" Confirm y ")
    expect(frame()).toContain(" Cancel Esc ")
    if (proof === "unavailable") h.server.diffReplies.push(Promise.resolve({ status: "unavailable", revision: 9, reason: "unretained" }))
    else h.server.diffReplies.push(Promise.resolve({
      ...retainedDiff(fileA.path, "+new edit", 1, 0, 9),
      diff: { path: fileA.path, change: fileA.change, patch: { kind: "unavailable" }, retainedLines: 0, renderedLines: 0, omittedLines: 0 },
    }))
    h.server.current.files = [{ ...fileA, editToken: { position: 9, eventId: "edit-a-2" } }, fileB]
    h.server.current.revision = 9
    h.server.change()
    await settle()
    await view.render()
    expect(frame()).toContain("Undo all changes to a.txt?")
    expect(frame()).toContain(" Confirm y ")
    expect(frame()).toContain(" Cancel Esc ")
    expect(frame()).toContain(proof === "unavailable" ? "Exact evidence is unavailable" : "File has newer edits")
    expect(view.span("Confirm").fg.equals(view.theme.textMuted)).toBe(true)
    h.modal.input({ name: "y" })
    if (proof === "unavailable") h.modal.input({ name: "u" })
    expect(h.server.mutations).toEqual([])
    h.server.current.files = [fileA, fileB]
    h.server.current.revision = 10
    await h.intake.view()!.controller.refresh()
    await waitForDiff(h.intake.view()!.controller, fileA.fileId, 10)
    await view.render()
    expect(frame()).toContain("Undo all changes to a.txt?")
    expect(view.span("Confirm").fg.equals(view.theme.textMuted)).toBe(false)
    h.server.breakLane()
    await view.render()
    expect(frame()).toContain("Undo all changes to a.txt?")
    expect(frame()).toContain(" Confirm y ")
    expect(frame()).toContain(" Cancel Esc ")
    expect(view.span("Confirm").fg.equals(view.theme.textMuted)).toBe(true)
    h.modal.input({ name: "y" })
    expect(h.server.mutations).toEqual([])
    h.modal.input({ name: "escape" })
    expect(h.intake.view()?.snapshot().undo).toBeUndefined()
    expect(h.modal.stack).toHaveLength(1)
    await view.render()
    expect(frame()).not.toContain("Undo all changes")
    h.server.lanes.open()
    await settle()
    h.modal.input({ name: "down" })
    h.modal.input({ name: "u" })
    await view.render()
    expect(frame()).toContain("Undo all changes to b.txt?")
    h.server.current.files = [fileA, { ...fileB, editToken: { position: 8, eventId: "edit-b-2" } }]
    h.server.current.revision = 8
    h.server.change()
    await settle()
    await waitForDiff(h.intake.view()!.controller, fileB.fileId, 8)
    await view.render()
    expect(frame()).toContain("File has newer edits; cancel or request Undo again")
    h.modal.input({ name: "y" })
    expect(h.server.mutations).toEqual([])
    h.modal.input({ name: "u" })
    h.server.undoReplies.push(Promise.resolve({ status: "refused", message: "Changes have moved on" }))
    h.modal.input({ name: "y" })
    h.modal.input({ name: "y" })
    await settle()
    expect(h.server.mutations).toEqual([{ type: "session.changes.undo", sessionId: "cold", fileId: fileB.fileId, revision: 8 }])
    await view.render()
    expect(frame()).toContain("Undo refused: Changes have moved on")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("keeps the cursor, expansion and viewport still while a confirmation owns the keyboard", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  const pageBy = spyOn(h.controls.listScroll, "pageBy")
  try {
    h.modal.input({ name: "u" })
    expect(h.intake.view()?.snapshot().undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
    for (const name of ["down", "j", "return", "pagedown", "pageup", "u"]) h.modal.input({ name })
    expect(h.controls.cursor()).toBe(0)
    expect(h.controls.isExpanded(fileA.fileId)).toBe(false)
    expect(pageBy).not.toHaveBeenCalled()
    expect(h.intake.view()?.snapshot().undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
    expect(h.modal.stack).toHaveLength(1)
    h.modal.input({ name: "y" })
    await settle()
    expect(h.server.mutations).toEqual([{ type: "session.changes.undo", sessionId: "cold", fileId: fileA.fileId, revision: 7 }])
    h.modal.input({ name: "down" })
    expect(h.controls.cursor()).toBe(1)
  } finally {
    pageBy.mockRestore()
    h.dispose()
  }
})

it("states a failed summary read inside the modal instead of loading forever", async () => {
  const h = harness()
  h.server.summaryReplies.push(Promise.reject(new Error("summary disconnected")))
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    expect(view.frame()).toContain("Could not read changes: summary disconnected")
    expect(view.frame()).not.toContain("Loading...")
    expect(view.span("Could not read changes").fg.equals(view.theme.error)).toBe(true)
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("shows unknown review authority while keeping its diff and Undo available", async () => {
  const h = harness()
  h.server.current.files = [{ ...fileA, review: { status: "unknown" } }]
  h.server.current.fileCount = 1
  h.server.diffReplies.push(Promise.resolve(addedLines(fileA.path, 3)))
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    await renderDiff(h, view, fileA.fileId)
    expect(view.frame()).toContain("[-] Review unknown")
    expect(view.frame()).toContain("line 1")
    h.modal.input({ name: "u" })
    await view.render()
    expect(view.frame()).toContain("Undo all changes to a.txt?")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("resets selection to the first file when the review reopens at the top", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.controls.openSessionChangesModal()
  await settle()
  h.modal.input({ name: "down" })
  expect(h.controls.cursor()).toBe(1)
  h.modal.input({ name: "escape" })
  h.controls.openSessionChangesModal()
  await settle()
  expect(h.controls.cursor()).toBe(0)
  h.dispose()
})

it("reveals the cursor header when an expanded file above it fills the viewport", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.server.current.files = [fileA, fileB, fileC]
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    const { frame } = view
    h.modal.input({ name: "down" })
    h.modal.input({ name: "return" })
    await view.render()
    expect(frame()).toContain("c.txt")
    // A real diff for b.txt longer than the viewport pushes c.txt out of it.
    h.server.current.revision = 8
    h.server.current.files = [fileA, { ...fileB, editToken: { position: 8, eventId: "edit-b-2" } }, fileC]
    h.server.diffReplies.push(Promise.resolve({ ...addedLines(fileB.path, 60), revision: 8 }))
    h.server.change()
    await settle()
    await renderDiff(h, view, fileB.fileId, 8)
    expect(h.controls.isExpanded(fileB.fileId)).toBe(true)
    expect(frame()).toContain("line 30")
    expect(frame()).not.toContain("c.txt")
    h.modal.input({ name: "down" })
    await view.render()
    expect(frame()).toContain("> c.txt")
    const preserveAnchor = spyOn(h.controls.listScroll, "preserveAnchor")
    const inserted = { ...fileC, fileId: "file:before-b", path: "/work/aa.txt", editToken: { position: 9, eventId: "edit-aa-1" } }
    h.server.current.files = [fileA, inserted, fileB, fileC]
    h.server.current.revision = 9
    h.server.change()
    await settle()
    expect(h.controls.rows()[h.controls.cursor()]?.key).toBe(fileC.fileId)
    expect(preserveAnchor).toHaveBeenCalled()
    h.server.current.files = [fileA, inserted, fileB]
    h.server.current.revision = 10
    h.server.change()
    await settle()
    expect(h.controls.rows()[h.controls.cursor()]?.key).toBe(fileB.fileId)
    preserveAnchor.mockRestore()
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("keeps the viewport offset inside a tall diff when that diff settles at a new height", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.server.current.files = [fileA, fileB, fileC]
  h.server.diffReplies.push(Promise.resolve(addedLines(fileA.path, 60)))
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    await renderDiff(h, view, fileA.fileId)
    h.modal.input({ name: "return" })
    await view.render()
    h.modal.input({ name: "pagedown" })
    await view.render()
    expect(h.controls.cursor()).toBe(0)
    expect(view.frame()).not.toContain("> a.txt")
    const beforeFrame = view.frame().split("\n")
    const anchorLine = beforeFrame.find(line => line.includes("line "))
    expect(anchorLine).toBeDefined()
    const before = beforeFrame.indexOf(anchorLine!)

    h.server.current.revision = 8
    h.server.current.files = [{ ...fileA, editToken: { position: 8, eventId: "edit-a-2" } }, fileB, fileC]
    h.server.diffReplies.push(Promise.resolve({ ...addedLines(fileA.path, 90), revision: 8 }))
    const patchGate = deferred<void>()
    h.server.patchGates.push(patchGate.promise)
    const controller = h.intake.view()!.controller
    const replacement = new Promise<void>(resolve => {
      const stop = controller.onChange(() => {
        const diff = controller.snapshot.diffs.get(fileA.fileId)
        if (diff?.status === "ready" && diff.lineCounts.added === 90) { stop(); resolve() }
      })
    })
    h.server.change()
    await settle()
    await view.render()
    const pendingFrame = view.frame()
    patchGate.resolve()
    expect(pendingFrame.split("\n").indexOf(anchorLine!)).toBe(before)
    await replacement
    await renderDiff(h, view, fileA.fileId, 8)
    await waitForTimer()
    await view.render()

    expect(view.frame().split("\n").indexOf(anchorLine!)).toBe(before)
    expect(h.controls.cursor()).toBe(0)
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})

it("marks the exact file Viewed, collapses its body, and keeps full-diff disclosure for a later edit", async () => {
  const h = harness()
  h.intake.start()
  await settle()
  h.server.diffReplies.push(Promise.resolve(addedLines(fileA.path, 30)))
  h.controls.openSessionChangesModal()
  await settle()
  const view = await renderModal(h)
  try {
    await renderDiff(h, view, fileA.fileId)
    h.modal.input({ name: "return" })
    await view.render()
    expect(view.frame()).toContain("line 30")
    h.modal.input({ name: "v" })
    await settle()
    await view.render()
    expect(h.server.mutations.at(-1)).toEqual({ type: "session.changes.set_viewed", sessionId: "cold", fileId: fileA.fileId, editToken: fileA.editToken, reviewed: true })
    expect(view.frame()).toContain("[x] Viewed")
    expect(view.frame()).not.toContain("line 1")
    h.modal.input({ name: "u" })
    await view.render()
    expect(view.frame()).toContain("Undo all changes to a.txt?")
    h.server.undoReplies.push(Promise.resolve({ status: "refused", message: "still changed" }))
    h.modal.input({ name: "y" })
    await settle()
    await view.render()
    expect(view.frame()).toContain("Undo refused: still changed")
    h.modal.input({ name: "return" })
    await settle()
    await view.render()
    expect(view.frame()).toContain("[ ] Viewed")
    expect(view.frame()).toContain("line 30")
    h.server.diffReplies.push(Promise.resolve({ ...addedLines(fileA.path, 30), revision: 10 }))
    h.server.current.files = [{ ...fileA, editToken: { position: 10, eventId: "edit-a-2" }, review: { status: "unviewed" } }, fileB]
    h.server.current.revision = 10
    h.server.change()
    await settle()
    await renderDiff(h, view, fileA.fileId, 10)
    expect(view.frame()).toContain("[ ] Viewed")
    expect(view.frame()).toContain("line 30")
  } finally {
    h.dispose()
    view.rendered.renderer.destroy()
  }
})
