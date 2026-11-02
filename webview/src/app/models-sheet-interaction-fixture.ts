import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { EffortOptionRow, ModelOptionRow, ModelSelectionSlot } from "../../../src/protocol/model-assignment-protocol-types.js"

import { fakeClient, fakePanelSettings, fakeSessionSummary, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import type { InlineSettingAction } from "../client/settings-actions.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { ModelsSheet } from "./sheets/models-sheet.js"
import { ModelSheet } from "./sheets/model-sheet.js"

const tick = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** Mounts the real Models sheet against a replaceable app frame. */
export function mountModelsSheet(kind: "models" | "model" = "models", held: { auth?: boolean; save?: boolean; roleId?: string; savedModel?: string; sessionKind?: "chat" | "subagent"; efforts?: boolean } = {}) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const roleId = held.roleId ?? "chat"
    const [state, setState] = createSignal(fakeViewState({
      sessionId: "session-a",
      settings: fakePanelSettings({
        seatSlot: { kind: "role", roleId },
        ...(held.efforts ? { seatEfforts: [{ effort: "low", label: "Low", current: true, selectable: true }, { effort: "max", label: "Max", current: false, selectable: true }] } : {}),
      }),
      sessions: [fakeSessionSummary({ id: "session-a", kind: held.sessionKind ?? "chat", title: "Session A" })],
    }))
    const queries: { readonly type: string; readonly scope?: unknown }[] = []
    const pendingOptions: Array<{
      resolve: (value: readonly ModelOptionRow[]) => void
      reject: (cause: unknown) => void
    }> = []
    const pendingEfforts: Array<(value: readonly EffortOptionRow[]) => void> = []
    const confirmations: Array<(confirmed: boolean) => void> = []
    const mutations: { readonly type: string; readonly scope?: unknown; readonly slot?: ModelSelectionSlot }[] = []
    const listeners = new Set<(event: FrontendEvent) => void>()
    const snapshots: Array<(revision: number) => void> = []
    const saves: Array<() => void> = []
    const reports: string[] = []
    const settingWrites: InlineSettingAction[] = []
    let closed = 0
    const auth = (revision: number) => ({
      providers: [], warnings: [],
      profile: { id: "session-profile", displayName: "Session", source: "default" as const, availableProfiles: [] },
      autoEnableNewModels: { enabled: true, eligibilityRevision: revision },
      subscriptionSpendConsent: { kind: "unavailable" as const, profileId: "session-profile", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." as const },
    })
    const connection = fakeRuntimeConnection({
      onQuery: (request) => { queries.push(request) },
      queries: {
        authStatusSnapshot: () => {
          if (held.auth) return new Promise((resolve) => { snapshots.push((revision) => resolve({ snapshotPosition: revision, auth: auth(revision) })) })
          return { snapshotPosition: 1, auth: auth(1) }
        },
        modelRoles: () => ({ roles: [{ id: roleId, label: roleId === "chat" ? "Chat" : roleId, description: "Role description", group: "core", order: 0 }] }),
        modelAssignments: () => [{
          slot: { kind: "role", roleId },
          label: roleId === "chat" ? "Chat" : roleId,
          model: "gpt-5",
          effort: "medium",
          modelSource: "explicit",
          matchesInheritedPair: false,
          ...(held.savedModel === undefined ? {} : { savedModel: held.savedModel }),
        }],
        modelOptions: () => new Promise((resolve, reject) => { pendingOptions.push({ resolve, reject }) }),
        effortOptions: () => new Promise((resolve) => { pendingEfforts.push(resolve) }),
      },
      onDispatch: (request) => {
        mutations.push(request)
        return request.type === "model.save_effort" && held.save ? new Promise<void>((resolve) => { saves.push(resolve) }) : undefined
      },
      mutations: {
        "model.save_effort": () => ({ label: "saved" }),
        "auth.catalog.refresh": () => ({ ok: true }),
      },
    }, {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    })
    const base = fakeClient({ connection })
    const client = fakeClient({
      state,
      connection,
      actions: { ...base.actions, applySetting: async (action) => { settingWrites.push(action); return { kind: "applied" } } },
      closeSheet() { closed += 1 },
      report(_severity, message) { reports.push(message) },
      confirm() { return new Promise((resolve) => { confirmations.push(resolve) }) },
    })
    Reflect.set(globalThis, "__flywheelModelsSheetTestClient", client)
    insert(root, createComponent(kind === "models" ? ModelsSheet : ModelSheet, {}))

    return {
      dispose(): void {
        disposeRoot()
        Reflect.deleteProperty(globalThis, "__flywheelModelsSheetTestClient")
      },
      ready: tick,
      releaseAuth: (revision: number) => snapshots.shift()?.(revision),
      releaseSave: () => saves.shift()?.(),
      closed: () => closed,
      reports: () => reports,
      settingWrites,
      text: () => textContent(root),
      queryCount: () => queries.filter((query) => query.type !== "authStatusSnapshot").length,
      row: (label: string) => nodes(root).find((node) => node.tag === "button" && textContent(node).includes(label)),
      body: () => nodes(root).find((node) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes("sheet-body")),
      async publishAuth(revision: number, sessionId: string | undefined = "session-a", position = revision): Promise<void> {
        for (const listener of listeners) listener({
          type: "patch",
          patch: {
            cursor: sessionId === undefined ? { scope: "workspace", domain: "auth" } : { scope: "session", domain: "auth", sessionId },
            position, prevPosition: position - 1, payload: { kind: "auth.changed", auth: auth(revision) },
          },
        })
        await tick()
      },
      refreshes: () => mutations.filter((mutation) => mutation.type === "auth.catalog.refresh"),
      click(label: string): void {
        const button = nodes(root).find((node) => node.tag === "button" && textContent(node).includes(label))
        if (!button) throw new Error(`Missing button: ${label}`)
        const handler = button.properties.onClick
        if (typeof handler !== "function") throw new Error(`Button has no click handler: ${label}`)
        handler()
      },
      resolveOptions(label: string, selectable = true, providers: ModelOptionRow["providers"] = []): void {
        const request = pendingOptions.shift()
        if (!request) throw new Error("No pending model options query")
        request.resolve([{ slot: { kind: "role", roleId: "chat" }, label, model: label, tier: "mid", selectable, current: true, efforts: ["medium", "high"], effort: "medium", providers, reason: selectable ? undefined : "Account cannot use this model." }])
      },
      /** The row's one-line detail, its element nodes for identity checks, and the providers in it that carry the serving emphasis. */
      detail(label: string) {
        const row = nodes(root).find((node) => node.tag === "button" && textContent(node).includes(label))
        const hasClass = (node: ReturnType<typeof nodes>[number], name: string) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(name)
        const detail = row === undefined ? undefined : nodes(row).find((node) => hasClass(node, "model-option-detail"))
        if (!detail) throw new Error(`Missing model detail: ${label}`)
        return {
          text: textContent(detail),
          elements: nodes(detail).filter((node) => node.tag === "span"),
          serving: nodes(detail).filter((node) => hasClass(node, "model-option-serving")).map(textContent),
        }
      },
      rejectOptions(): void { pendingOptions.shift()?.reject(new Error("offline")) },
      resolveEfforts(count: number): void {
        const resolve = pendingEfforts.shift()
        if (!resolve) throw new Error("No pending effort options query")
        resolve(Array.from({ length: count }, (_, index): EffortOptionRow => ({
          slot: { kind: "role", roleId },
          label: index === 0 ? "Medium" : "High",
          effort: index === 0 ? "medium" : "high",
          selectable: true,
          current: index === 0,
        })))
      },
      mutations: () => mutations.filter((mutation) => mutation.type !== "auth.catalog.refresh"),
      settleConfirmation(confirmed: boolean): void {
        const settle = confirmations.shift()
        if (!settle) throw new Error("No pending confirmation")
        settle(confirmed)
      },
      async publishEquivalentFrame(): Promise<void> {
        setState((current) => ({ ...current }))
        await tick()
      },
      async selectSession(sessionId: string): Promise<void> {
        setState((current) => ({ ...current, sessionId }))
        await tick()
      },
    }
  })
}
