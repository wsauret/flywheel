import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedQuery, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useModelModal } from "../../../../src/tui/hooks/use-model-modal.js"

function harness(roleId = "chat") {
  const queries: string[] = []
  const saves: FrontendMutation[] = []
  const modals = createModalStack()
  const toasts: string[] = []
  const answers = runtimeQuery({
    authStatusSnapshot: async () => ({ snapshotPosition: 0, auth: {
      providers: [], warnings: [], profile: { id: "personal", displayName: "Personal", source: "default", availableProfiles: [] },
      subscriptionSpendConsent: { kind: "available", profileId: "personal", usageGeneration: 0, authorityIncarnation: "test", authorityRevision: 0, accounts: [] },
    } }),
    modelAssignments: async (request) => request.slots.some((slot) => slot.roleId === roleId) ? [{
      slot: { kind: "role", roleId }, label: roleId, model: "gpt-6-luna", effort: "low",
      modelSource: "default", matchesInheritedPair: true, savedModel: "lost-model",
    }] : [],
    modelOptions: async (request) => [{
      slot: request.slot, model: "gpt-6-luna", label: "gpt-6-luna", effort: "low", efforts: ["low", "high"],
      selectable: true, current: true, providers: [],
    }],
  })
  // Every query counts, answered or not, so a test can assert that none was sent.
  const query = recordedQuery((request) => { queries.push(request.type) }, answers)
  const dispatch = runtimeDispatch({
    "auth.catalog.refresh": async () => ({ ok: true }),
    "model.save_effort": async (command) => { saves.push(command); return { label: roleId } },
  })
  const service = {
    subscribe: () => () => {},
    onLane: fakeLanes().onLane, query, dispatch,
  } satisfies Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  const hook = useModelModal({
    modal: modals,
    renderModal: () => null,
    showToast: (toast) => toasts.push(toast.message),
    appService: service,
    foregroundSessionId: () => "session-a",
  })
  return { hook, queries, saves, modals, toasts }
}

describe("model modal global defaults", () => {
  test("does not query global defaults during render", () => {
    createRoot((dispose) => {
      const { hook, queries } = harness()
      expect(hook.modelModalState().loading).toBe(false)
      expect(queries).toEqual([])
      dispose()
    })
  })

  test.each(["chat", "workflow-agent", "brief.plan.at.worker"])("replaces a broken %s setting with honest scope", async (roleId) => {
    let dispose = () => {}
    const { hook, saves, modals, toasts } = createRoot((cleanup) => {
      dispose = cleanup
      return harness(roleId)
    })
    try {
      const record = roleId === "brief.plan.at.worker"
      if (record) await hook.openActiveModelPicker({ sessionId: "session-a", slot: { kind: "role", roleId }, label: "Plan" })
      else {
        await hook.openModelsModal()
        const index = hook.modelModalState().assignmentItems.findIndex((item) => item.kind === "assignment" && item.row.slot.roleId === roleId)
        hook.selectModelItem(index)
        modals.input({ name: "return" })
      }
      for (let turn = 0; turn < 20; turn++) await Promise.resolve()
      expect(hook.modelModalState().profileOwned).toBe(roleId === "workflow-agent")
      expect(hook.modelModalState().scopeToggleAvailable).toBe(roleId === "chat")
      expect(hook.modelModalState().savedModel).toBe("lost-model")
      expect(hook.modelModalState().modelOptions.map((row) => row.model)).toEqual(["gpt-6-luna"])
      if (roleId !== "chat") {
        modals.input({ name: "g", ctrl: true })
        for (let turn = 0; turn < 20; turn++) await Promise.resolve()
        expect(hook.modelModalState().scope).toBe("session")
        expect(hook.modelModalState().view.kind).toBe("models")
      }
      modals.input({ name: "return" })
      for (let turn = 0; turn < 20; turn++) await Promise.resolve()
      expect(saves).toEqual([{ type: "model.save_effort", scope: { kind: "session", sessionId: "session-a" }, slot: { kind: "role", roleId }, model: "gpt-6-luna", effort: "low" }])
      expect(toasts.at(-1)).toBe(roleId === "workflow-agent" ? `Updated ${roleId} for this auth profile` : record ? "Updated Plan for this subagent" : "Updated chat for this tab")
    } finally { dispose() }
  })
})
