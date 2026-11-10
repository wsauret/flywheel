import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { FrontendEvent, FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { backgroundCursor, type BackgroundPatchPayload, type BackgroundWorkRow, type BackgroundWorkTarget } from "../../../../src/protocol/background-index-protocol-types.js"
import type { BackgroundIndexState } from "../../../../src/protocol/client/background-index.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"
import { useBackgroundModal } from "../../../../src/tui/hooks/use-background-modal.js"
import { createBackgroundIndexFollower, type BackgroundIndexView } from "../../../../src/tui/hooks/create-background-index.js"
import type { ShellServices } from "../../../../src/tui/hooks/shell-state.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { buildCommandCatalog } from "../../../helpers/command-catalog.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

type BackgroundTerminate = Extract<FrontendMutation, { readonly type: "background.terminate" }>

const BG_COMMAND = { id: "bg", title: "Background work", description: "Manage background commands", aliases: ["tasks"] } as const
const row = (fields: Partial<BackgroundWorkRow> & Pick<BackgroundWorkRow, "id" | "status">): BackgroundWorkRow => ({
  kind: "command", title: fields.id, startedAtMs: 0, cardToolUseId: fields.id, ...fields,
})
/** Two running commands, a running workflow with a finished subagent nested
 *  under it, and a finished command. */
const ROWS: readonly BackgroundWorkRow[] = [
  row({ id: "tool-a", title: "first server", status: "running", startedAtMs: 100, stop: { sessionId: "chat-1", toolUseId: "tool-a" } }),
  row({ id: "workflow", kind: "workflow", title: "Implement", status: "running", startedAtMs: 200, target: { kind: "workflow", workflowId: "workflow" }, cardToolUseId: "toolu_workflow", stop: { sessionId: "chat-1", toolUseId: "toolu_workflow" } }),
  row({ id: "reviewer", kind: "subagent", title: "Reviewer", status: "completed", startedAtMs: 250, target: { kind: "session", sessionId: "reviewer" }, parentRowId: "workflow", cardToolUseId: "toolu_workflow" }),
  row({ id: "tool-b", title: "second worker", status: "running", startedAtMs: 300, stop: { sessionId: "chat-1", toolUseId: "tool-b" } }),
  row({ id: "tool-c", title: "unit tests", status: "completed", startedAtMs: 400, exitCode: 0, durationMs: 2_000 }),
]

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface StreamingToolText {
  [toolUseId: string]: { content: string }
}

interface RoleViews {
  readonly [sessionId: string]: RoleAssignmentView | undefined
}

function createModal(options: {
  rows?: readonly BackgroundWorkRow[]
  dispatch?: (command: BackgroundTerminate) => Promise<MutationResult<BackgroundTerminate>>
  showToast?: ShellServices["showToast"]
  streamingToolText?: StreamingToolText
  roles?: RoleViews
  /** The real follower, in place of a fake that holds `rows` for every session. */
  index?: BackgroundIndexView
} = {}) {
  const [state, setState] = createSignal<BackgroundIndexState>({ status: "ready", rows: options.rows ?? ROWS })
  const [streamingToolText, setStreamingToolText] = createSignal(options.streamingToolText ?? {})
  const [roles, setRoles] = createSignal(options.roles ?? {})
  // The sessions whose held index the list read, and those it followed: none.
  const shown = new Set<string>()
  const followed: string[] = []
  const modals = createModalStack()
  const dispatch = mock<NonNullable<typeof options.dispatch>>(options.dispatch ?? (async () => ({ ok: true })))
  const showToast = mock<ShellServices["showToast"]>(options.showToast ?? (() => {}))
  const navigateToProcess = mock((_toolUseId: string) => {})
  const openTarget = mock((_target: BackgroundWorkTarget) => {})
  const ensureRoleViews = mock((_sessionIds: readonly string[]) => {})
  const modal = useBackgroundModal({
    modal: modals,
    renderModal: () => "mock-element",
    signals: {
      foregroundId: () => "chat-1",
      backgroundIndex: options.index ?? {
        state: (sessionId) => { shown.add(sessionId); return state() },
        follow: (sessionId) => { followed.push(sessionId); return () => {} },
        start: () => {},
      },
      streamingToolText,
      roleView: (sessionId: string) => roles()[sessionId],
      ensureRoleViews,
    },
    appService: { dispatch: runtimeDispatch({ "background.terminate": dispatch }) },
    showToast,
    navigateToProcess,
    openTarget,
  })
  const press = (name: string) => modals.stack[0]?.onKey?.({ name })
  const ids = () => modal.backgroundModalResult().rows.map((candidate) => candidate.id)
  return { modal, modals, dispatch, showToast, navigateToProcess, openTarget, ensureRoleViews, setState, setStreamingToolText, setRoles, shown, followed, press, ids }
}

describe("useBackgroundModal", () => {
  it("opens a viewer's index, reads its output, and lands on its own transcript", () => {
    createRoot((dispose) => {
      const fixture = createModal({ streamingToolText: { "tool-a": { content: "parent output" } } })
      const navigateToProcess = mock((_toolUseId: string) => {})
      fixture.modal.openBackgroundModal({
        sessionId: "workflow",
        streamingToolText: () => ({ "tool-a": { content: "workflow output\n" } }),
        navigateToProcess,
      })
      // The viewer follows its index; the list only reads what it holds.
      expect([...fixture.shown]).toEqual(["workflow"])
      expect(fixture.followed).toEqual([])
      fixture.press("space")
      expect(fixture.modal.backgroundModalTail("tool-a")).toEqual(["workflow output"])
      fixture.modal.landBackgroundRow(0)
      expect(navigateToProcess).toHaveBeenCalledWith("tool-a")
      expect(fixture.navigateToProcess).not.toHaveBeenCalled()
      fixture.modal.openBackgroundModal()
      fixture.press("space")
      expect(fixture.modal.backgroundModalTail("tool-a")).toEqual(["parent output"])
      fixture.modal.landBackgroundRow(0)
      expect(fixture.navigateToProcess).toHaveBeenCalledWith("tool-a")
      dispose()
    })
  })

  it("shows the foreground chat's held index, opens on Active, and `a` shows All with finished rows", () => {
    createRoot((dispose) => {
      const fixture = createModal()
      fixture.modal.openBackgroundModal()

      expect([...fixture.shown]).toEqual(["chat-1"])
      expect(fixture.ids()).toEqual(["tool-a", "workflow", "tool-b"])
      fixture.press("a")
      expect(fixture.modal.backgroundModalFilter()).toBe("all")
      expect(fixture.ids()).toEqual(["tool-a", "workflow", "reviewer", "tool-b", "tool-c"])
      expect(fixture.modal.backgroundModalResult().rows[4]).toMatchObject({ kind: "option", option: { rightDetail: "Completed · exit 0 · 2.0s", value: { dimmed: true } } })
      fixture.press("a")
      expect(fixture.ids()).toEqual(["tool-a", "workflow", "tool-b"])
      fixture.press("down")
      fixture.setState({ status: "ready", rows: [row({ id: "new", status: "running" }), ...ROWS.map((entry) => ({ ...entry }))] })
      expect(fixture.modal.backgroundModalResult().rows[fixture.modal.backgroundModalCursor()]?.id).toBe("workflow")
      fixture.setState({ status: "ready", rows: ROWS.map((entry) => ({ ...entry })) })

      fixture.setState({ status: "ready", rows: [ROWS[3]!] })
      expect(fixture.ids()).toEqual(["tool-b"])
      fixture.press("escape")
      // Opening and closing the list follow and let go of nothing.
      expect(fixture.followed).toEqual([])
      dispose()
    })
  })

  it("opens on the held rows of the followed foreground chat with no read, and row patches change them while open and while closed", async () => {
    const lanes = fakeLanes()
    const listeners = new Set<(event: FrontendEvent) => void>()
    const counter = countStateRequests({ query: runtimeQuery({ sessionBackgroundWork: async () => ({ snapshotPosition: 1, rows: ROWS }) }) })
    let position = 1
    const patch = (payload: BackgroundPatchPayload) => {
      position += 1
      for (const listener of listeners) listener({ type: "patch", patch: { cursor: backgroundCursor("chat-1"), position, prevPosition: position - 1, payload } })
    }
    await createRoot(async (dispose) => {
      const index = createBackgroundIndexFollower({
        client: {
          query: (request) => counter.reader.query(request),
          dispatch: runtimeDispatch({ "background.release": async () => ({ ok: true }) }),
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          onLane: lanes.onLane,
        },
        foregroundId: () => "chat-1",
      })
      const fixture = createModal({ index })
      fixture.modal.openBackgroundModal()
      expect(fixture.modal.backgroundModalEmpty()).toBe("Reading background work…")
      fixture.press("escape")
      expect(counter.take()).toEqual([])

      index.start()
      await flush()
      expect(counter.take().map((request) => request.method)).toEqual(["query"])

      fixture.modal.openBackgroundModal()
      expect(fixture.ids()).toEqual(["tool-a", "workflow", "tool-b"])
      patch({ kind: "background.row.updated", row: { ...ROWS[3]!, status: "completed" } })
      expect(fixture.ids()).toEqual(["tool-a", "workflow"])
      fixture.press("escape")

      patch({ kind: "background.row.removed", rowId: "tool-a" })
      fixture.modal.openBackgroundModal()
      expect(fixture.ids()).toEqual(["workflow"])
      await flush()
      expect(counter.take()).toEqual([])
      dispose()
    })
  })

  it("follows each child an open viewer shows beside the foreground chat, and lets the runtime go of it when the viewer closes", async () => {
    const lanes = fakeLanes()
    const counter = countStateRequests({ query: runtimeQuery({ sessionBackgroundWork: async () => ({ snapshotPosition: 1, rows: ROWS }) }) })
    const released: string[] = []
    await createRoot(async (dispose) => {
      const index = createBackgroundIndexFollower({
        client: {
          query: (request) => counter.reader.query(request),
          dispatch: runtimeDispatch({ "background.release": async (mutation) => { released.push(mutation.sessionId); return { ok: true } } }),
          subscribe: () => () => {},
          onLane: lanes.onLane,
        },
        foregroundId: () => "chat-1",
      })
      index.start()
      const closeFirst = index.follow("child-1")
      // A second viewer of the same child keeps it followed when the first closes.
      const closeSecond = index.follow("child-1")
      await flush()
      expect(index.state("child-1")).toEqual({ status: "ready", rows: ROWS })
      closeFirst()
      await flush()
      expect(released).toEqual([])
      expect(index.state("child-1")).toEqual({ status: "ready", rows: ROWS })

      closeSecond()
      await flush()
      expect(counter.take().map((request) => request.args[0])).toEqual([
        { type: "sessionBackgroundWork", sessionId: "chat-1" },
        { type: "sessionBackgroundWork", sessionId: "child-1" },
      ])
      expect(released).toEqual(["child-1"])
      expect(index.state("child-1")).toEqual({ status: "loading" })
      expect(index.state("chat-1")).toEqual({ status: "ready", rows: ROWS })
      dispose()
    })
  })

  it("names the toggle when no work is active", () => {
    createRoot((dispose) => {
      const fixture = createModal({ rows: [ROWS[4]!] })
      fixture.modal.openBackgroundModal()
      expect(fixture.ids()).toEqual([])
      expect(fixture.modal.backgroundModalEmpty()).toBe("No active background work · a shows all")
      dispose()
    })
  })

  it("hydrates linked child roles in one batch and reacts to their current model and effort", async () => {
    const rows = [
      row({ id: "review", kind: "subagent", status: "running", startedAtMs: 1, target: { kind: "session", sessionId: "review" }, model: "gpt-6.1-sol", effort: "low", roleSessionId: "child-review" }),
      row({ id: "analyze", kind: "subagent", status: "running", startedAtMs: 2, target: { kind: "session", sessionId: "analyze" }, model: "claude-haiku-4-5", effort: "low", roleSessionId: "child-analyze" }),
      row({ id: "server", status: "running", startedAtMs: 3 }),
    ]
    const fixture = await new Promise<ReturnType<typeof createModal> & { dispose: () => void }>((resolve) => {
      createRoot((dispose) => resolve({ ...createModal({ rows }), dispose }))
    })
    fixture.modal.openBackgroundModal()
    await flush()

    expect(fixture.ensureRoleViews.mock.calls.at(-1)?.[0]).toEqual(["child-review", "child-analyze"])
    expect(fixture.modal.backgroundModalResult().rows[0]).toMatchObject({ kind: "option", option: { rightDetail: "Running · gpt-6.1-sol · low" } })
    expect(fixture.modal.backgroundModalResult().rows[2]).toMatchObject({ kind: "option", option: { rightDetail: "Running" } })

    fixture.setRoles({ "child-review": { assignments: { chat: { model: "wrong", effort: "low" } }, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "claude-opus-4-6", effort: "high" } } } })
    expect(fixture.modal.backgroundModalResult().rows[0]).toMatchObject({ kind: "option", option: { rightDetail: "Running · claude-opus-4-6 · high" } })
    expect(fixture.modal.backgroundModalResult().rows[1]).toMatchObject({ kind: "option", option: { rightDetail: "Running · claude-haiku-4-5 · low" } })
    fixture.dispose()
  })

  it("`x` stops the selected row through its launching call without a toast, and a finished row has no Stop", async () => {
    const fixture = await new Promise<ReturnType<typeof createModal>>((resolve) => {
      createRoot(() => resolve(createModal()))
    })
    fixture.modal.openBackgroundModal()
    fixture.press("down")
    fixture.press("x")
    await flush()

    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "background.terminate", sessionId: "chat-1", toolUseId: "toolu_workflow" }]])
    expect(fixture.showToast).not.toHaveBeenCalled()

    fixture.press("a")
    fixture.modal.stopBackgroundRow(4)
    await flush()
    expect(fixture.dispatch.mock.calls).toHaveLength(1)
  })

  it("a click closes the list and lands on the row's card, and a nested row lands on its top-level card", () => {
    createRoot((dispose) => {
      const fixture = createModal()
      fixture.modal.openBackgroundModal()
      fixture.modal.landBackgroundRow(1)
      expect(fixture.modals.stack).toHaveLength(0)
      expect(fixture.navigateToProcess.mock.calls).toEqual([["toolu_workflow"]])

      fixture.modal.openBackgroundModal()
      fixture.press("a")
      fixture.modal.landBackgroundRow(2)
      expect(fixture.navigateToProcess.mock.calls.at(-1)).toEqual(["toolu_workflow"])
      expect(fixture.dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("Enter opens a child in its viewer and lands a command on its card", () => {
    createRoot((dispose) => {
      const fixture = createModal()
      fixture.modal.openBackgroundModal()
      fixture.press("down")
      fixture.press("return")
      // A workflow opens as its full-size card.
      expect(fixture.openTarget.mock.calls).toEqual([[{ kind: "workflow", workflowId: "workflow" }]])
      expect(fixture.modals.stack).toHaveLength(0)

      fixture.modal.openBackgroundModal()
      fixture.press("return")
      expect(fixture.navigateToProcess.mock.calls).toEqual([["tool-a"]])
      expect(fixture.dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("opens the full-size card of the workflow whose agent started a command", () => {
    createRoot((dispose) => {
      const rows = [ROWS[1]!, row({ id: "tool-w", title: "agent server", status: "running", startedAtMs: 300, parentRowId: "member", cardToolUseId: "toolu_workflow", target: { kind: "session", sessionId: "member" } })]
      const { modal, press, openTarget, navigateToProcess } = createModal({ rows })
      modal.openBackgroundModal()
      press("down")
      press("return")
      expect(openTarget.mock.calls).toEqual([[{ kind: "session", sessionId: "member" }]])
      expect(navigateToProcess).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("surfaces a transport failure as an error toast", async () => {
    const dispatch = mock(async () => { throw new Error("worker gone") })
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const { modal } = await new Promise<ReturnType<typeof createModal>>((resolve) => {
      createRoot(() => resolve(createModal({ dispatch, showToast })))
    })
    modal.openBackgroundModal()
    modal.stopBackgroundRow(0)
    await flush()

    expect(showToast.mock.calls.at(-1)?.[0]).toEqual({ message: "worker gone", variant: "error" })
  })

  it("clamps the cursor when the list shrinks under it", () => {
    createRoot((dispose) => {
      const { modal, setState } = createModal()
      modal.openBackgroundModal()
      modal.stopBackgroundRow(2)
      expect(modal.backgroundModalCursor()).toBe(2)

      setState({ status: "ready", rows: [ROWS[0]!] })
      expect(modal.backgroundModalCursor()).toBe(0)

      setState({ status: "ready", rows: [] })
      expect(modal.backgroundModalCursor()).toBe(0)
      dispose()
    })
  })

  it("expands the live tail of a running command with Space, never of a child, and resets on reopen", () => {
    createRoot((dispose) => {
      const { modal, dispatch, navigateToProcess, setStreamingToolText, press } = createModal()
      modal.openBackgroundModal()

      setStreamingToolText({ "tool-a": { content: "one\ntwo\nthree\n" } })
      expect(modal.backgroundModalTail("tool-a")).toBeUndefined()
      press("space")
      expect(modal.backgroundModalTail("tool-a")).toEqual(["one", "two", "three"])

      press("down")
      press("space")
      expect(modal.backgroundModalTail("workflow")).toBeUndefined()
      press("down")
      press("space")
      expect(modal.backgroundModalTail("tool-b")).toEqual([])

      const long = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")
      setStreamingToolText({ "tool-a": { content: "updated\n" }, "tool-b": { content: long } })
      expect(modal.backgroundModalTail("tool-a")).toEqual(["updated"])
      expect(modal.backgroundModalTail("tool-b")).toEqual(Array.from({ length: 12 }, (_, i) => `line-${i + 8}`))

      press("escape")
      modal.openBackgroundModal()
      expect(modal.backgroundModalTail("tool-b")).toBeUndefined()
      expect(dispatch).not.toHaveBeenCalled()
      expect(navigateToProcess).not.toHaveBeenCalled()
      dispose()
    })
  })
})

// The runtime owns the capability decision; the catalog only reads the
// projection it published.
describe("/bg visibility", () => {
  it("omits /bg before its runtime descriptor arrives", () => {
    expect(buildCommandCatalog(() => "ctrl+x").find((spec) => spec.id === "bg")).toBeUndefined()
  })

  it("hides /reflect while the runtime projects no Learning review command", () => {
    const spec = buildCommandCatalog(() => "ctrl+x", [BG_COMMAND]).find((candidate) => candidate.id === "learn")
    expect(spec).toBeUndefined()
  })
})
