import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ModelAssignmentRow, ModelOptionRow } from "../../../../src/protocol/model-assignment-protocol-types.js";
import type { AttachedRuntimeClient, FrontendEvent, FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { createModalStack, type ModalContext } from "../../../../src/tui/components/modal-stack.js"
import { descriptionLine, modalHelpRows, modalTitle, contextLine } from "../../../../src/tui/modals/model-modal-chrome.js"
import type { ModelModalState } from "../../../../src/tui/modals/model-modal-types.js"
import { authStatusCursor, type RuntimeAuthStatusScope, type RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { useModelModal } from "../../../../src/tui/hooks/use-model-modal.js"
import {
  scopeChromeColor,
  scopeContextLine,
  scopeSaveToast,
} from "../../../../src/tui/hooks/use-model-modal-scope.js"
import { fakeRow, theme } from "./_model-modal-fixtures"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
const rows: readonly ModelAssignmentRow[] = [
  fakeRow("chat", "Chat"),
  fakeRow("workflow-agent", "Workflow"),
  fakeRow("explorer", "Explorer"),
]

interface ModalHarness {
  modals: ModalContext
  modelModal: ReturnType<typeof useModelModal>
  loads: string[]
  resets: string[]
  saves: Array<Extract<FrontendMutation, { type: "model.save_effort" }>>
  toasts: string[]
  refreshes: string[]
}

interface ModalOptions {
  /** The foreground chat's title. */
  title?: string
  effort?: "high" | null
  failSessionSave?: boolean
  modelCurrent?: boolean
  modelOptions?: readonly ModelOptionRow[]
  failedCatalog?: boolean
  keepSavedRows?: boolean
  refreshGate?: Promise<void>
  modelOptionsAfterRefresh?: readonly ModelOptionRow[]
  refreshStillFails?: boolean
}

async function withModal(foreground: string | undefined, run: (harness: ModalHarness) => Promise<void> | void, opts: ModalOptions = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [foregroundSessionId] = createSignal(foreground)
      const modals = createModalStack()
      const loads: string[] = []
      const resets: string[] = []
      const saves: Array<Extract<FrontendMutation, { type: "model.save_effort" }>> = []
      const toasts: string[] = []
      const refreshes: string[] = []
      let refreshed = false
      const listeners = new Set<(event: FrontendEvent) => void>()
      const scopes: RuntimeAuthStatusScope[] = []
      const auth: RuntimeAuthView = {
        profile: { id: "Work", displayName: "Work", source: "default", availableProfiles: [] },
        autoEnableNewModels: { enabled: true, eligibilityRevision: 1 },
        providers: [], warnings: [],
        subscriptionSpendConsent: { kind: "unavailable", profileId: "Work", message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE },
      }
      const query = runtimeQuery({
        authStatusSnapshot: async (request) => {
          scopes.push(request.scope)
          return { snapshotPosition: 0, auth }
        },
        modelAssignments: async (request) => {
          loads.push(request.scope.kind)
          if (opts.failedCatalog && !refreshed && !opts.keepSavedRows) throw new Error("No assignable models were returned by provider listing.")
          return rows
        },
        modelOptions: async () => (refreshed && opts.modelOptionsAfterRefresh) || opts.modelOptions || [{ slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: opts.modelCurrent ?? true, efforts: ["low", "high"], effort: opts.effort ?? "high", providers: [] }],
      })
      const dispatch = runtimeDispatch({
        "auth.catalog.refresh": async (command) => {
          refreshes.push(command.scope.kind)
          if (opts.failedCatalog && opts.refreshGate) void opts.refreshGate.then(() => {
            refreshed = !opts.refreshStillFails
            for (const scope of scopes) {
              for (const listener of listeners) listener({ type: "patch", patch: { cursor: authStatusCursor(scope), position: 1, prevPosition: 0, payload: { kind: "auth.changed", auth: { ...auth, autoEnableNewModels: { enabled: true, eligibilityRevision: 2 } } } } })
            }
          })
          return { ok: true }
        },
        "model.save_effort": async (command) => {
          saves.push(command)
          if (command.scope.kind === "defaults-and-session") {
            if (opts.failSessionSave) return { label: "Chat", warning: "Default saved, but this tab was not updated: session write refused", mirrored: false }
            return { label: "Chat", mirrored: !(command.model !== null && command.effort == null) }
          }
          return { label: "Chat" }
        },
        "model.reset_assignments": async (command) => {
          resets.push(command.scope.kind)
          return command.scope.kind === "defaults-and-session" ? { rows, mirrored: true } : { rows }
        },
      })
      const modelModal = useModelModal({
        modal: modals,
        renderModal: () => "",
        showToast: (toast) => { toasts.push(toast.message) },
        appService: { query, dispatch, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, onLane: fakeLanes().onLane } satisfies Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">,
        foregroundSessionId,
        foregroundTitle: () => opts.title,
      })
      Promise.resolve(run({ modals, modelModal, loads, resets, saves, toasts, refreshes }))
        .then(resolve, reject)
        .finally(dispose)
    })
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function state(overrides: Partial<ModelModalState> = {}): ModelModalState {
  return {
    view: { kind: "assignments" },
    scope: "session",
    scopeToggleAvailable: true,
    assignmentItems: [{ kind: "assignment", row: fakeRow("chat", "Chat"), depth: 0 }],
    modelOptions: [],
    query: "",
    pendingEfforts: new Map(),
    cursor: 0,
    loading: false,
    confirmReset: false,
    ...overrides,
  }
}

describe("model modal scopes", () => {
  test("a failed provider catalog retries and restores other providers' default assignments in place", async () => {
    const gate = Promise.withResolvers<void>()
    await withModal("session-1", async ({ modals, modelModal, loads, refreshes }) => {
      await modelModal.openModelsModal()
      expect(modelModal.modelModalState().loading).toBe(false)
      modals.input({ name: "g" })
      expect(refreshes).toEqual(["session", "defaults"])
      gate.resolve()
      for (let i = 0; i < 10 && modelModal.modelModalState().assignmentItems.length === 0; i++) await Bun.sleep(0)
      expect(loads.length).toBeGreaterThan(1)
      expect(modelModal.modelModalState().scope).toBe("defaults")
      expect(modelModal.modelModalState().assignmentItems.length).toBeGreaterThan(0)
    }, { failedCatalog: true, refreshGate: gate.promise })
  })

  test("refreshes an open picker after a failed account recovers without losing its selection", async () => {
    const gate = Promise.withResolvers<void>()
    const after = [
      { slot: roleSlot("chat"), model: "gpt-x", label: "gpt-x", selectable: true, current: true, efforts: ["low", "high"], effort: "high", providers: [] },
      { slot: roleSlot("chat"), model: "claude-new", label: "claude-new", selectable: true, current: false, efforts: ["low"], effort: "low", providers: [] },
    ] satisfies readonly ModelOptionRow[]
    await withModal("session-1", async ({ modals, modelModal, refreshes, saves }) => {
      await modelModal.openModelsModal()
      expect(modelModal.modelModalState().assignmentItems.length).toBeGreaterThan(0)
      modals.input({ name: "return" })
      await settle()
      expect(modelModal.modelModalState().view.kind).toBe("models")
      expect(modelModal.modelModalState().modelOptions).toHaveLength(1)
      gate.resolve()
      for (let i = 0; i < 10 && modelModal.modelModalState().modelOptions.length === 1; i++) await Bun.sleep(0)
      expect(refreshes).toEqual(["session"])
      expect(modelModal.modelModalState().modelOptions).toHaveLength(2)
      expect(modelModal.modelModalState().modelOptions[modelModal.modelModalState().cursor]?.model).toBe("gpt-x")
      modals.input({ name: "return" })
      await settle()
      expect(saves).toHaveLength(1)
    }, { failedCatalog: true, keepSavedRows: true, refreshGate: gate.promise, modelOptionsAfterRefresh: after })
  })

  test("a failed account refresh does not block saving another provider's model", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves, refreshes }) => {
      await modelModal.openModelsModal()
      modals.input({ name: "g" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      expect(modelModal.modelModalState().modelOptions[0]?.model).toBe("gpt-x")
      modals.input({ name: "return" })
      await settle()
      expect(refreshes).toEqual(["session", "defaults"])
      expect(saves.map((save) => save.model)).toEqual(["gpt-x"])
    }, { failedCatalog: true, keepSavedRows: true, refreshStillFails: true })
  })

  test("opening chooses session scope only when a foreground session exists", async () => {
    await withModal("session-1", async ({ modelModal }) => {
      modelModal.openModelsModal()
      await settle()

      expect(modelModal.modelModalState().scope).toBe("session")
      expect(modelModal.modelModalState().scopeToggleAvailable).toBe(true)
    })

    await withModal(undefined, async ({ modelModal }) => {
      modelModal.openModelsModal()
      await settle()

      expect(modelModal.modelModalState().scope).toBe("defaults")
      expect(modelModal.modelModalState().scopeToggleAvailable).toBe(false)
    })
  })

  test("g toggles available scopes and resets view and cursor", async () => {
    await withModal("session-1", async ({ modals, loads, modelModal }) => {
      modelModal.openModelsModal()
      await settle()
      modelModal.selectModelItem(1)

      modals.input({ name: "g" })
      await settle()

      expect(modelModal.modelModalState().scope).toBe("defaults")
      expect(modelModal.modelModalState().view).toEqual({ kind: "assignments" })
      expect(modelModal.modelModalState().cursor).toBe(0)
      expect(loads.at(-1)).toBe("defaults")

      modelModal.selectModelItem(0)
      modals.input({ name: "return" })
      await settle()
      expect(modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Chat" })

      modals.input({ name: "g", ctrl: true })
      await settle()

      expect(modelModal.modelModalState().scope).toBe("session")
      expect(modelModal.modelModalState().view).toEqual({ kind: "assignments" })
      expect(modelModal.modelModalState().cursor).toBe(0)
      expect(loads.at(-1)).toBe("session")
    })
  })

  test("g is a no-op when no tab scope exists", async () => {
    await withModal(undefined, async ({ modals, loads, modelModal }) => {
      modelModal.openModelsModal()
      await settle()
      const loadCount = loads.length

      modals.input({ name: "g" })
      await settle()

      expect(modelModal.modelModalState().scope).toBe("defaults")
      expect(modelModal.modelModalState().scopeToggleAvailable).toBe(false)
      expect(loads).toHaveLength(loadCount)
    })
  })

  test("Ctrl+R reset routes through the active session controller", async () => {
    await withModal("session-1", async ({ modals, modelModal, resets }) => {
      modelModal.openModelsModal()
      await settle()

      modals.input({ name: "r", ctrl: true })
      expect(modelModal.modelModalState().confirmReset).toBe(true)
      expect(resets).toEqual([])

      modals.input({ name: "r", ctrl: true })
      await settle()

      expect(resets).toEqual(["session"])
    })
  })

  test("defaults-scope reset sends one compound command covering the foreground tab", async () => {
    await withModal("session-1", async ({ modals, modelModal, resets }) => {
      modelModal.openModelsModal()
      await settle()
      modals.input({ name: "g" })
      await settle()

      modals.input({ name: "r", ctrl: true })
      modals.input({ name: "r", ctrl: true })
      await settle()
      await settle()

      expect(resets).toEqual(["defaults-and-session"])
    })
  })

  test("session-scope save stays session-only", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves }) => {
      modelModal.openModelsModal()
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      await settle()

      expect(saves.map((s) => s.scope)).toEqual([{ kind: "session", sessionId: "session-1" }])
    })
  })

  test("Model and effort deep-links to the chat model picker in the active scope, under the chat's title", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves }) => {
      await modelModal.openActiveModelPicker()

      expect(modelModal.modelModalState().scope).toBe("session")
      expect(modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Fix the login bug", direct: true })
      expect(modalTitle(modelModal.modelModalState())).toBe("Model and effort: Fix the login bug")

      modals.input({ name: "return" })
      await settle()
      await settle()
      expect(saves.map((s) => s.scope)).toEqual([{ kind: "session", sessionId: "session-1" }])
      expect(modals.stack).toHaveLength(0)
    }, { title: "Fix the login bug" })

    await withModal(undefined, async ({ modelModal }) => {
      await modelModal.openActiveModelPicker()

      expect(modelModal.modelModalState().scope).toBe("defaults")
      expect(modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Chat", direct: true })
    })
  })

  test("Model and effort resolves the chat seat's inherit row to its model", async () => {
    const chatSlot = roleSlot("chat")
    await withModal("session-1", async ({ modals, modelModal, saves }) => {
      await modelModal.openActiveModelPicker()

      expect(modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Chat", direct: true })

      modals.input({ name: "return" })
      await settle()
      await settle()
      expect(saves).toEqual([{
        type: "model.save_effort",
        scope: { kind: "session", sessionId: "session-1" },
        slot: chatSlot,
        model: "sol-5.6",
        effort: "high",
      }])
      expect(modals.stack).toHaveLength(0)
    }, {
      modelOptions: [
        { slot: chatSlot, model: null, label: "Inherit Default", selectable: true, current: true, inherit: true, inheritModel: "sol-5.6", efforts: ["medium", "high"], effort: "medium", providers: [] },
        { slot: chatSlot, model: "sol-5.6", label: "sol-5.6", selectable: true, efforts: ["medium", "high"], effort: "high", providers: [] },
      ],
    })
  })

  test("Model and effort lands on the model list when no current option exists", async () => {
    await withModal("session-1", async ({ modelModal }) => {
      await modelModal.openActiveModelPicker()

      expect(modelModal.modelModalState().view).toEqual({ kind: "models", displayLabel: "Chat", direct: true })
    }, { modelCurrent: false })
  })

  test("closing the modals mid-flight abandons Model and effort", async () => {
    await withModal("session-1", async ({ modals, modelModal }) => {
      const shortcut = modelModal.openActiveModelPicker()
      modals.clear()
      await shortcut

      expect(modals.stack).toHaveLength(0)
      expect(modelModal.modelModalState().view).toEqual({ kind: "assignments" })
    })
  })

  test("backing out of Model and effort restores manual save navigation", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves }) => {
      await modelModal.openActiveModelPicker()

      modals.input({ name: "backspace" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()

      expect(saves).toHaveLength(1)
      expect(modals.stack).toHaveLength(1)
      expect(modelModal.modelModalState().view).toEqual({ kind: "assignments" })
    })
  })

  test("defaults-scope concrete model save reports its mirrored tab update", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves, toasts }) => {
      modelModal.openModelsModal()
      await settle()
      modals.input({ name: "g" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      await settle()

      expect(saves.map((s) => s.scope)).toEqual([{ kind: "defaults-and-session", sessionId: "session-1" }])
      expect(toasts.at(-1)).toBe("Updated Chat default for new sessions and this tab")
    })
  })

  test("mirror failure keeps the defaults save and degrades to a warning toast", async () => {
    await withModal("session-1", async ({ modals, modelModal, saves, toasts, loads }) => {
      modelModal.openModelsModal()
      await settle()
      modals.input({ name: "g" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      modals.input({ name: "return" })
      await settle()
      await settle()

      expect(saves.map((s) => s.scope.kind)).toEqual(["defaults-and-session"])
      expect(toasts.at(-1)).toBe("Default saved, but this tab was not updated: session write refused")
      expect(loads.at(-1)).toBe("defaults")
    }, { failSessionSave: true })
  })

  test("scope helpers produce exact copy and chrome colors", () => {
    expect(scopeSaveToast("session", "Chat")).toBe("Updated Chat for this tab")
    expect(scopeSaveToast("defaults", "Chat")).toBe("Updated Chat default for new sessions")
    expect(scopeSaveToast("defaults", "Chat", true)).toBe("Updated Chat default for new sessions and this tab")
    expect(scopeContextLine("session")).toBe("Changes apply to this tab only.")
    expect(scopeContextLine("defaults")).toBe("New sessions only; open tabs keep their models.")
    expect(scopeContextLine("defaults", true)).toBe("New sessions and this tab; other tabs keep their models.")
    expect(scopeChromeColor("session", theme)).toBe(theme.primary)
    expect(scopeChromeColor("defaults", theme)).toBe(theme.warning)
  })

  test("modal chrome derives titles, context, and help from scope", () => {
    const sessionModelState = state({
      view: { kind: "models", displayLabel: "Chat" },
      modelOptions: [{ slot: roleSlot("chat"), model: "gpt-5.5", label: "gpt-5.5", selectable: true, efforts: ["medium"], effort: "medium", providers: [] }],
    })
    const defaultsModelState = state({
      scope: "defaults",
      view: { kind: "models", displayLabel: "Chat" },
      modelOptions: [{ slot: roleSlot("chat"), model: "gpt-5.5", label: "gpt-5.5", selectable: true, efforts: ["medium"], effort: "medium", providers: [] }],
    })

    expect(modalTitle(sessionModelState)).toBe("Models › This tab › Chat › Model")
    expect(modalTitle(defaultsModelState)).toBe("Models › New session defaults › Chat › Model")
    expect(contextLine(state({ scope: "session" }))).toBe("Changes apply to this tab only.")
    expect(contextLine(state({ scope: "defaults" }))).toBe("New sessions and this tab; other tabs keep their models.")
    expect(contextLine(state({ scope: "defaults", scopeToggleAvailable: false }))).toBe("New sessions only; open tabs keep their models.")
    expect(modalHelpRows(state({ scope: "session", scopeToggleAvailable: true }), 66).join(" ")).toContain("g defaults")
    expect(modalHelpRows(state({ scope: "defaults", scopeToggleAvailable: true }), 66).join(" ")).toContain("g this tab")
    expect(modalHelpRows(state({ scopeToggleAvailable: false }), 66).join(" ")).not.toContain("g defaults")
    expect(modalHelpRows(state({ scope: "defaults", scopeToggleAvailable: false }), 66).join(" ")).not.toContain("g this tab")
    const collapsedReviewer = state({
      assignmentItems: [{ kind: "assignment", row: fakeRow("reviewer", "Reviewer"), depth: 0, disclosure: { id: "reviewer", interaction: "primary-and-disclosure", expanded: false } }],
    });
    const expandedReviewer = state({
      assignmentItems: [{ kind: "assignment", row: fakeRow("reviewer", "Reviewer"), depth: 0, disclosure: { id: "reviewer", interaction: "primary-and-disclosure", expanded: true } }],
    });
    expect(modalHelpRows(collapsedReviewer, 66).join(" ")).toContain("space expand");
    expect(modalHelpRows(expandedReviewer, 66).join(" ")).toContain("space collapse");
  })

  test("only an adjusted concrete Anthropic row warns about the prompt cache", () => {
    const option = (model: string) => ({ slot: roleSlot("chat"), model, label: model, selectable: true, efforts: ["low", "high"] as const, effort: "low" as const, providers: [] })
    const anthropic = state({ view: { kind: "models" }, modelOptions: [option("claude-opus-4-7")], pendingEfforts: new Map([["claude-opus-4-7", "high"]]) })
    const openai = state({ view: { kind: "models" }, modelOptions: [option("gpt-5.5")], pendingEfforts: new Map([["gpt-5.5", "high"]]) })
    const unchanged = state({ view: { kind: "models" }, modelOptions: [option("claude-opus-4-7")] })
    expect(descriptionLine(anthropic)).toBe("An effort change invalidates the Anthropic prompt cache.")
    expect(descriptionLine(openai)).toBe("")
    expect(descriptionLine(unchanged)).toBe("")
  })
})
