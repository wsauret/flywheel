import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ModelAssignmentRow, ModelSelectionSlot, ModelOptionRow, RuntimeModelAssignmentWriteScope } from "../../../../src/protocol/model-assignment-protocol-types.js";
import type { AttachedRuntimeClient, FrontendEvent, FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { authStatusCursor, type RuntimeAuthStatusScope, type RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { modalTitle, contextLine } from "../../../../src/tui/modals/model-modal-chrome.js"
import { createOverlayLayers, type ModalContext, type OverlayLayers } from "../../../../src/tui/components/modal-stack.js"
import { useModelModal } from "../../../../src/tui/hooks/use-model-modal.js"
import { createSettingsTree } from "../../../../src/tui/hooks/settings-tree.js"
import { fakeRow } from "./_model-modal-fixtures"

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
// Operation identity: every model-modal RPC is correlated with the operation
// that launched it. A response that arrives after the operation was superseded
// (scope toggled, view navigated, modal closed) cannot install rows, clear
// loading for a newer operation, navigate, or toast.

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const sessionRows: readonly ModelAssignmentRow[] = [fakeRow("chat", "Session Chat")]
const defaultsRows: readonly ModelAssignmentRow[] = [fakeRow("chat", "Defaults Chat")]

interface Harness {
  overlay: OverlayLayers
  modal: ModalContext
  modelModal: ReturnType<typeof useModelModal>
  assignmentCalls: Array<Deferred<readonly ModelAssignmentRow[]>>
  optionCalls: Array<Deferred<readonly ModelOptionRow[]>>
  /** The slot of each model options query, in order. */
  optionSlots: ModelSelectionSlot[]
  saveCalls: Array<Deferred<{ label: string }>>
  toasts: string[]
  scopes: RuntimeModelAssignmentWriteScope[]
  slots: ModelSelectionSlot[][]
  commands: FrontendMutation[]
  publishCatalog: (scope: RuntimeAuthStatusScope, revision: number) => Promise<void>
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [foregroundSessionId] = createSignal<string | undefined>("session-1")
      const overlay = createOverlayLayers()
      const modal = overlay.dialog
      const settingsTree = createSettingsTree(modal)
      settingsTree.bindRoot({
        open: () => { modal.replace("settings") },
        isOpen: () => modal.stack[0]?.element === "settings",
      })
      const assignmentCalls: Harness["assignmentCalls"] = []
      const optionCalls: Harness["optionCalls"] = []
      const optionSlots: ModelSelectionSlot[] = []
      const saveCalls: Harness["saveCalls"] = []
      const toasts: string[] = []
      const scopes: RuntimeModelAssignmentWriteScope[] = []
      const slots: ModelSelectionSlot[][] = []
      const commands: FrontendMutation[] = []
      const listeners = new Set<(event: FrontendEvent) => void>()
      const sequencer = createRuntimeUiPatchSequencer()
      const catalogAuth = (revision: number): RuntimeAuthView => ({
        autoEnableNewModels: { enabled: true, eligibilityRevision: revision },
        providers: [], warnings: [],
        profile: { id: "Work", displayName: "Work", source: "default", availableProfiles: [] },
        subscriptionSpendConsent: { kind: "unavailable", profileId: "Work", message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE },
      })
      const publishCatalog = async (scope: RuntimeAuthStatusScope, revision: number) => {
        const patch = sequencer.publish({ cursor: authStatusCursor(scope), payload: { kind: "auth.changed", auth: catalogAuth(revision) } })
        for (const listener of listeners) listener({ type: "patch", patch })
        await flush()
      }
      const queryRuntime = runtimeQuery({
        authStatusSnapshot: (query) => Promise.resolve({ snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: authStatusCursor(query.scope) }), auth: catalogAuth(1) }),
        modelAssignments: (query) => {
          scopes.push(query.scope)
          slots.push([...query.slots])
          const call = deferred<readonly ModelAssignmentRow[]>()
          assignmentCalls.push(call)
          return call.promise
        },
        modelOptions: (query) => {
          scopes.push(query.scope)
          optionSlots.push(query.slot)
          const call = deferred<readonly ModelOptionRow[]>()
          optionCalls.push(call)
          return call.promise
        },
      })
      const dispatch = recordedDispatch((command) => { commands.push(command) }, runtimeDispatch({
        "auth.catalog.refresh": () => Promise.resolve({ ok: true }),
        "model.save_effort": (command) => {
          scopes.push(command.scope)
          const call = deferred<{ label: string }>()
          saveCalls.push(call)
          return call.promise
        },
        "model.reset_assignments": () => Promise.resolve({ rows: sessionRows }),
      }))
      const modelModal = useModelModal({
        modal: settingsTree.childModal,
        renderModal: () => "",
        showToast: (toast) => { toasts.push(toast.message) },
        appService: {
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          onLane: fakeLanes().onLane,
          query: queryRuntime,
          dispatch,
        } satisfies Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">,
        foregroundSessionId,
      })
      Promise.resolve(run({ overlay, modal, modelModal, assignmentCalls, optionCalls, optionSlots, saveCalls, toasts, scopes, slots, commands, publishCatalog }))
        .then(resolve, reject)
        .finally(dispose)
    })
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function assignmentLabels(harness: Harness): string[] {
  return harness.modelModal.modelModalState().assignmentItems
    .flatMap((item) => (item.kind === "assignment" ? [item.row.label] : []))
}

describe("model modal operation identity", () => {
  test("model search owns printable keys and navigates the filtered rows", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      harness.optionCalls[0]!.resolve(Array.from({ length: 24 }, (_, index) => ({
        slot: roleSlot("chat"), model: `model-${index}`, label: `ghjkl ${index}`,
        selectable: index !== 0, current: index === 12,
        efforts: ["low", "high"], effort: "high", providers: [],
      })))
      await flush()
      for (const name of "ghjkl") harness.modal.input({ name, sequence: name })
      expect(harness.modelModal.modelModalState().query).toBe("ghjkl")
      expect(harness.modelModal.modelModalState().scope).toBe("session")
      expect(harness.modelModal.modelModalState().pendingEfforts.size).toBe(0)
      for (const [name, cursor] of [["end", 23], ["home", 0], ["pagedown", 10], ["pageup", 0]] as const) {
        harness.modal.input({ name })
        expect(harness.modelModal.modelModalState().cursor).toBe(cursor)
      }
      harness.modal.input({ name: "space", sequence: " " })
      harness.modal.input({ name: "2", sequence: "2" })
      expect(harness.modelModal.modelModalState().modelOptions.map((row) => row.model)).toEqual(["model-2", "model-20", "model-21", "model-22", "model-23"])
      harness.modal.input({ name: "end" })
      expect(harness.modelModal.modelModalState().cursor).toBe(4)
      harness.modal.input({ name: "x", sequence: "x" })
      expect(harness.modelModal.modelModalState().modelOptions).toEqual([])
      harness.modal.input({ name: "return" })
      expect(harness.saveCalls).toHaveLength(0)
      harness.modal.input({ name: "backspace" })
      expect(harness.modelModal.modelModalState().query).toBe("ghjkl 2")
      expect(harness.modelModal.modelModalState().view.kind).toBe("models")
      expect(harness.commands.filter((command) => command.type.startsWith("model."))).toEqual([])
    })
  })

  test.each(["escape", "backspace", "scope"] as const)("unconfirmed effort is discarded by %s without a write", async (exit) => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      const option = { slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"] as const, effort: "high" as const, providers: [] }
      harness.optionCalls[0]!.resolve([option])
      await flush()
      harness.modal.input({ name: "left" })
      expect(harness.modelModal.modelModalState().pendingEfforts.get("gpt-x")).toBe("low")
      harness.modal.input(exit === "scope" ? { name: "g", ctrl: true } : { name: exit })
      await flush()
      expect(harness.modelModal.modelModalState().pendingEfforts.size).toBe(0)
      expect(harness.commands.filter((command) => command.type.startsWith("model."))).toEqual([])
      if (exit === "scope") expect(harness.modelModal.modelModalState().scope).toBe("defaults")
      else if (exit === "backspace") expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")
      else expect(harness.modal.stack).toHaveLength(0)
    })
  })

  test("seeds scoped auth before saved reads and retains publications during the initial option read", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      expect(harness.assignmentCalls).toHaveLength(0)
      expect(harness.modelModal.modelModalState().auth).toBeUndefined()
      await flush()
      expect(harness.modelModal.modelModalState().auth?.profile.id).toBe("Work")
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      expect(harness.optionCalls).toHaveLength(1)
      const option = { slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["high"] as const, effort: "high" as const, providers: [] }
      await harness.publishCatalog({ kind: "session", sessionId: "session-1" }, 2)
      expect(harness.optionCalls).toHaveLength(1)
      harness.optionCalls[0]!.resolve([option])
      await flush()
      expect(harness.optionCalls).toHaveLength(2)
      expect(harness.modelModal.modelModalState().loading).toBe(false)
      expect(harness.modelModal.modelModalState().modelOptions).toHaveLength(1)
      harness.optionCalls[1]!.resolve([{ ...option, label: "Fresh" }])
      await flush()
      expect(harness.modelModal.modelModalState().modelOptions[0]?.label).toBe("Fresh")
      expect(harness.optionCalls).toHaveLength(2)
      harness.modelModal.closeModelModal()
      void harness.modelModal.openModelsModal()
      expect(assignmentLabels(harness)).toEqual(["Session Chat"])
      expect(harness.modelModal.modelModalState().loading).toBe(false)
      expect(harness.modelModal.modelModalState().auth?.profile.id).toBe("Work")
    })
  })
  test("defaults observe their own catalog rather than the foreground tab", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      harness.modal.input({ name: "g" })
      await flush()
      harness.assignmentCalls[1]!.resolve(defaultsRows)
      await flush()
      expect(harness.commands.at(-1)).toEqual({ type: "auth.catalog.refresh", scope: { kind: "defaults" } })
      await harness.publishCatalog({ kind: "defaults" }, 2)
      const reads = harness.assignmentCalls.length
      await harness.publishCatalog({ kind: "session", sessionId: "session-1" }, 3)
      expect(harness.assignmentCalls).toHaveLength(reads)
      await harness.publishCatalog({ kind: "defaults" }, 2)
      expect(harness.assignmentCalls).toHaveLength(reads)
      harness.modelModal.closeModelModal()
      await harness.publishCatalog({ kind: "defaults" }, 4)
      expect(harness.assignmentCalls).toHaveLength(reads)
    })
  })

  test("child catalog publications preserve selection and effort without taking over a save", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker({ sessionId: "child", slot: roleSlot("chat"), label: "probe › api" })
      await flush()
      expect(harness.commands).toContainEqual({ type: "auth.catalog.refresh", scope: { kind: "session", sessionId: "child" } })
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      const option = { slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"] as const, effort: "high" as const, providers: [] }
      harness.optionCalls[0]!.resolve([option])
      await flush()
      expect(harness.optionCalls).toHaveLength(1)
      for (const name of "gpt") harness.modal.input({ name, sequence: name })
      harness.modal.input({ name: "left" })
      await harness.publishCatalog({ kind: "session", sessionId: "child" }, 2)
      expect(harness.modelModal.modelModalState().loading).toBe(false)
      harness.optionCalls.at(-1)!.resolve([{ ...option, model: "new-model", label: "new-model", current: false }, { ...option, model: "gpt-new", label: "gpt-new", current: false }, { ...option }])
      await flush()
      expect(harness.modelModal.modelModalState().cursor).toBe(1)
      expect(harness.modelModal.modelModalState().query).toBe("gpt")
      expect(harness.modelModal.modelModalState().modelOptions[1]?.model).toBe("gpt-x")
      expect(harness.modelModal.modelModalState().pendingEfforts.get("gpt-x")).toBe("low")
      expect(harness.toasts).toEqual([])
      await harness.publishCatalog({ kind: "session", sessionId: "child" }, 3)
      const background = harness.optionCalls.at(-1)!
      harness.modal.input({ name: "return" })
      await flush()
      background.resolve([])
      await flush()
      expect(harness.modelModal.modelModalState().loading).toBe(true)
      expect(harness.modelModal.modelModalState().modelOptions).toHaveLength(2)
      harness.saveCalls[0]!.resolve({ label: "Chat" })
      await flush()
      expect(harness.modal.stack).toHaveLength(0)
      expect(harness.toasts).toContain("Updated probe › api for this subagent")
    })
  })
  test("a removed highlighted model uses the nearest runtime row without saving a replacement", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      const option = { slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"] as const, effort: "high" as const, providers: [] }
      harness.optionCalls[0]!.resolve([option])
      await flush()
      harness.modal.input({ name: "left" })
      await harness.publishCatalog({ kind: "session", sessionId: "session-1" }, 2)
      harness.optionCalls.at(-1)!.resolve([{ ...option, model: "replacement", label: "replacement" }, { ...option, selectable: false, reason: "Account unavailable" }])
      await flush()
      expect(harness.modelModal.modelModalState().modelOptions[harness.modelModal.modelModalState().cursor]).toMatchObject({ model: "gpt-x", selectable: false })
      expect(harness.modelModal.modelModalState().pendingEfforts.get("gpt-x")).toBe("low")
      await harness.publishCatalog({ kind: "session", sessionId: "session-1" }, 3)
      harness.optionCalls.at(-1)!.resolve([{ ...option, model: "replacement", label: "replacement" }])
      await flush()
      const state = harness.modelModal.modelModalState()
      expect(state.modelOptions).toHaveLength(1)
      expect(state.modelOptions[state.cursor]).toMatchObject({ model: "replacement", selectable: true })
      expect(state.pendingEfforts.size).toBe(0)
      expect(harness.saveCalls).toHaveLength(0)
    })
  })
  test("a child picker stays above its viewer and never reads the foreground scope", async () => {
    await withHarness(async (harness) => {
      const draft = { text: "preserved draft" }
      const viewerBody = () => draft.text
      const viewer = harness.overlay.viewer.push(viewerBody)
      void harness.modelModal.openActiveModelPicker({ sessionId: "child", slot: roleSlot("chat"), label: "probe › api" })
      await flush()
      expect(viewer.isOpen()).toBe(true)
      expect(viewer.isActive()).toBe(true)
      expect(viewer.isFocused()).toBe(false)
      expect(harness.overlay.viewer.stack).toHaveLength(1)
      expect(harness.overlay.viewer.stack[0]?.element).toBe(viewerBody)
      expect(harness.modal.stack).toHaveLength(1)
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      expect(harness.modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "probe › api", direct: true })
      expect(harness.modelModal.modelModalState().scopeToggleAvailable).toBe(false)
      expect(modalTitle(harness.modelModal.modelModalState())).toBe("Model and effort: probe › api")
      expect(harness.slots[0]).not.toContainEqual(roleSlot("brief.parent.at.parent"))
      expect(contextLine({ ...harness.modelModal.modelModalState(), view: { kind: "assignments" } })).toBe("Changes apply to this subagent only.")
      harness.modal.input({ name: "g", ctrl: true })
      expect(harness.assignmentCalls).toHaveLength(1)
      expect(harness.scopes).toEqual([{ kind: "session", sessionId: "child" }, { kind: "session", sessionId: "child" }])
      harness.optionCalls[0]!.resolve([{ slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"], effort: "high", providers: [] }])
      await flush()
      harness.modal.input({ name: "return" })
      await flush()
      expect(harness.saveCalls).toHaveLength(1)
      expect(harness.scopes.at(-1)).toEqual({ kind: "session", sessionId: "child" })
      harness.saveCalls[0]!.resolve({ label: "Child model" })
      await flush()
      expect(harness.toasts).toContain("Updated probe › api for this subagent")
      expect(harness.modal.stack).toHaveLength(0)
      expect(harness.overlay.viewer.stack).toHaveLength(1)
      expect(harness.overlay.viewer.stack[0]?.element).toBe(viewerBody)
      expect(draft.text).toBe("preserved draft")
      expect(viewer.isOpen()).toBe(true)
      expect(viewer.isActive()).toBe(true)
      expect(viewer.isFocused()).toBe(true)
    })
  })
  test("a stale active-picker continuation cannot navigate its replacement dialog", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      const staleDialog = harness.modal.stack.at(-1)
      harness.overlay.dialog.clear()

      void harness.modelModal.openModelsModal()
      await flush()
      const replacementDialog = harness.modal.stack.at(-1)
      expect(replacementDialog).not.toBe(staleDialog)

      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()

      expect(harness.modal.stack.at(-1)).toBe(replacementDialog)
      expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")
      expect(harness.optionCalls).toHaveLength(0)
    })
  })
  test("the active-model shortcut targets chat when no agent of a workflow runs", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      expect(harness.optionCalls).toHaveLength(1)
      expect(harness.modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Session Chat", direct: true })
    })
  })
  test("a workflow agent's picker edits its record seat under the agent's name, never Chat", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker({ sessionId: "workflow", slot: roleSlot("brief.review.at.check"), label: "review › check" })
      await flush()
      harness.assignmentCalls[0]!.resolve([...sessionRows, fakeRow("brief.review", "Review")])
      await flush()
      expect(harness.optionCalls).toHaveLength(1)
      expect(harness.optionSlots).toEqual([{ kind: "role", roleId: "brief.review.at.check" }])
      expect(harness.scopes.at(-1)).toEqual({ kind: "session", sessionId: "workflow" })
      expect(harness.modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "review › check", direct: true })
      harness.optionCalls[0]!.resolve([{ slot: roleSlot("brief.review.at.check"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["high"], effort: "high", providers: [] }])
      harness.assignmentCalls[1]!.resolve([fakeRow("brief.review.at.check", "Review")])
      await flush()
      harness.modal.input({ name: "return" })
      await flush()
      harness.saveCalls[0]!.resolve({ label: "Chat" })
      await flush()
      expect(harness.toasts).toEqual(["Updated review › check for this subagent"])
    })
  })
  test("a superseded assignments load cannot overwrite the current scope's rows", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      expect(harness.assignmentCalls).toHaveLength(1)

      harness.modal.input({ name: "g" })
      await flush()
      expect(harness.assignmentCalls).toHaveLength(2)

      harness.assignmentCalls[1]!.resolve(defaultsRows)
      await flush()
      expect(assignmentLabels(harness)).toEqual(["Defaults Chat"])
      expect(harness.modelModal.modelModalState().loading).toBe(false)

      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      expect(assignmentLabels(harness)).toEqual(["Defaults Chat"])
    })
  })

  test("a model-options load that resolves after back-navigation installs nothing", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()

      harness.modal.input({ name: "return" })
      expect(harness.optionCalls).toHaveLength(1)
      expect(harness.modelModal.modelModalState().view.kind).toBe("models")

      harness.modal.input({ name: "backspace" })
      expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")
      expect(harness.modelModal.modelModalState().loading).toBe(false)

      harness.optionCalls[0]!.resolve([{ slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"], effort: "high", providers: [] }])
      await flush()
      expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")
      expect(harness.modelModal.modelModalState().modelOptions).toHaveLength(0)
      expect(harness.toasts).toHaveLength(0)
    })
  })

  test("a load resolving after close cannot update the reopened modal", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.modal.input({ name: "escape" })
      expect(harness.modal.stack).toHaveLength(0)

      void harness.modelModal.openModelsModal()
      await flush()
      expect(harness.assignmentCalls).toHaveLength(2)
      harness.assignmentCalls[1]!.resolve(defaultsRows)
      await flush()
      expect(assignmentLabels(harness)).toEqual(["Defaults Chat"])

      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      expect(assignmentLabels(harness)).toEqual(["Defaults Chat"])
      expect(harness.toasts).toHaveLength(0)
    })
  })

  test("a late save completion cannot navigate a newer view or toast", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()

      harness.modal.input({ name: "return" })
      harness.optionCalls[0]!.resolve([{ slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"], effort: "high", providers: [] }])
      await flush()
      expect(harness.modelModal.modelModalState().view.kind).toBe("models")

      harness.modal.input({ name: "return" })
      await flush()
      expect(harness.saveCalls).toHaveLength(1)

      harness.modal.input({ name: "backspace" })
      expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")

      harness.saveCalls[0]!.resolve({ label: "Chat" })
      await flush()
      expect(harness.modelModal.modelModalState().view.kind).toBe("assignments")
      expect(harness.toasts).toHaveLength(0)
    })
  })

  test("a brief slot can save its inherited Workflow Agent selection", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.assignmentCalls[0]!.resolve([fakeRow("brief.plan", "Plan")])
      await flush()

      harness.modal.input({ name: "return" })
      harness.optionCalls[0]!.resolve([{
        slot: roleSlot("brief.plan"),
        model: null,
        label: "gpt-steps",
        selectable: true,
        current: true,
        inherit: true,
        efforts: ["high"],
        effort: "high",
        providers: [],
      }])
      await flush()

      harness.modal.input({ name: "return" })
      expect(harness.saveCalls).toHaveLength(1)
    })
  })

  test("Space expands Reviewer without opening its picker and Enter still edits it", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal();
      await flush()
      harness.assignmentCalls[0]!.resolve([
        fakeRow("reviewer", "Reviewer"),
        fakeRow("reviewer-design", "Design"),
      ]);
      await flush();

      expect(assignmentLabels(harness)).toEqual(["Reviewer"]);
      harness.modal.input({ name: "space" });
      expect(assignmentLabels(harness)).toEqual(["Reviewer", "Design"]);
      expect(harness.optionCalls).toHaveLength(0);

      harness.modal.input({ name: "return" });
      expect(harness.optionCalls).toHaveLength(1);
      expect(harness.modelModal.modelModalState().view).toMatchObject({ kind: "models", displayLabel: "Reviewer" });
    });
  });

  test("a stale load failure produces no error toast", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openModelsModal()
      await flush()
      harness.modal.input({ name: "escape" })

      harness.assignmentCalls[0]!.reject(new Error("rpc timeout"))
      await flush()
      expect(harness.toasts).toHaveLength(0)
    })
  })
  test("a late close-on-save cannot clear a replacement modal", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      harness.optionCalls[0]!.resolve([{ slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"], effort: "high", providers: [] }])
      await flush()
      expect(harness.modelModal.modelModalState().view.kind).toBe("models")

      harness.modal.input({ name: "return" })
      expect(harness.saveCalls).toHaveLength(1)
      harness.modal.replace("replacement")
      harness.saveCalls[0]!.resolve({ label: "Chat" })
      await flush()

      expect(harness.modal.stack).toHaveLength(1)
      expect(harness.modal.stack[0]?.element).toBe("replacement")
    })
  })

  test("Model and effort seats the settings root; saving dismisses the whole stack", async () => {
    await withHarness(async (harness) => {
      void harness.modelModal.openActiveModelPicker()
      await flush()
      expect(harness.modal.stack).toHaveLength(2)
      expect(harness.modal.stack[0]?.element).toBe("settings")
      harness.assignmentCalls[0]!.resolve(sessionRows)
      await flush()
      harness.optionCalls[0]!.resolve(["gpt-x", "gpt-y"].map((model, index) => ({
        slot: roleSlot("chat"), model, label: model, selectable: true, current: index === 0,
        efforts: ["low", "high"], effort: "high", providers: [],
      })))
      await flush()
      expect(harness.modelModal.modelModalState().view.kind).toBe("models")

      harness.modal.input({ name: "left" })
      harness.modal.input({ name: "down" })
      harness.modal.input({ name: "left" })
      harness.modal.input({ name: "y", sequence: "y" })
      harness.modal.input({ name: "return" })
      expect(harness.saveCalls).toHaveLength(1)
      expect(harness.commands.filter((command) => command.type.startsWith("model."))).toEqual([{
        type: "model.save_effort", scope: { kind: "session", sessionId: "session-1" },
        slot: roleSlot("chat"), model: "gpt-y", effort: "low",
      }])
      harness.saveCalls[0]!.resolve({ label: "Chat" })
      await flush()

      expect(harness.modal.stack).toHaveLength(0)
    })
  })

})
