import { Key } from "@solid-primitives/keyed"
import { createMemo, createResource, onCleanup, Show, type JSX } from "solid-js"
import { describeUpdateStatus } from "../../../../src/protocol/client/update-status-copy.js"

import { readModuleStatusRows, sameModuleStatusScope, type ModuleStatusScope } from "../../../../src/protocol/client/module-status.js"
import { pageDomainReader } from "../../client/module-domain-views.js"
import { moduleRows } from "../../../../src/protocol/modules.js"
import type { ModuleRow, ModuleRowAction } from "../../../../src/protocol/protocol-module.js"
import { WEB_MODULES } from "../../modules.js"
import type { WebModule } from "../../web-module.js"
import { describeFailure } from "../../client/failure-message.js"
import type { BudgetSummary } from "../../../../src/protocol/client/host-contract.js"
import type { RuntimeHealth } from "../../../../src/protocol/app-service-types.js"
import { runtimeFaultCopy } from "../../../../src/protocol/client/runtime-fault-copy.js"
import { actionKey } from "../../client/action-key.js"
import { useClient } from "../client-context.js"
import { SheetLoading, SheetRow } from "./sheet.js"
import { WorkspaceSurface } from "../workspace-surface.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** One module row as a sheet row, in Status or Settings: the hint is the
 *  detail under the label, a warning tone colours the label, and an action
 *  makes the row a button. */
export function ModuleRowView(props: { readonly row: ModuleRow; readonly onAction: (action: ModuleRowAction) => void }): JSX.Element {
  const action = () => props.row.action
  return (
    <SheetRow
      label={props.row.label}
      value={props.row.value}
      tone={props.row.tone === "warning" ? "warn" : undefined}
      detail={props.row.hint}
      onClick={action() === undefined ? undefined : () => { const current = action(); if (current) props.onAction(current) }}
    />
  )
}

/** What the runtime knows about itself, in one place.
 *
 *  These are unrelated reads (this session, its model roles, updates, and
 *  every module's own report) that share one property: a person
 *  goes looking for them only when something seems off. So they are one list
 *  that answers "what is the state of things", with the row that has a problem
 *  saying so, and the action that fixes it attached to that row. */
export function StatusSheet(props: { readonly docked?: boolean; readonly onClose?: () => void } = {}) {
  const client = useClient()
  const state = client.state
  const runtime = () => runtimeReading(state().health)
  const settled = async <T,>(read: Promise<T>): Promise<T | undefined> => read.catch(() => undefined)
  const [facts] = createResource(async () => {
    const sessionId = state().sessionId
    const [detail, roles] = await Promise.all([
      sessionId === undefined ? undefined : settled(client.connection.query({ type: "sessionDetail", sessionId })),
      sessionId === undefined ? undefined : settled(client.connection.query({ type: "roleSnapshot", sessionIds: [sessionId] })),
    ])
    return { detail: detail?.view ?? undefined, roles: roles?.views[0]?.view ?? undefined }
  })
  const statusScope = createMemo<ModuleStatusScope, undefined>(() => ({ sessionId: state().sessionId, profileId: state().authStatus?.auth.profile.id, moduleIds: state().settings?.moduleIds ?? WEB_MODULES.map((module) => module.id) }), undefined, { equals: sameModuleStatusScope })
  let generation = 0
  let mounted = true
  onCleanup(() => { mounted = false; generation += 1 })
  const [queriedRows] = createResource(statusScope, async (scope) => {
    const request = ++generation
    const rows = await readModuleStatusRows(WEB_MODULES, scope, (module: WebModule, sessionId) => module.status?.(client.connection, sessionId), (module, error) => {
      if (mounted && request === generation && statusScope() === scope) client.report("warning", `The ${module.id} module could not read its status: ${describeFailure(error)}`)
    }, () => state().health.kind !== "faulted")
    return { scope, rows }
  })
  const rows = () => {
    const result = queriedRows()
    return [...moduleRows("status", pageDomainReader(state), state().settings?.moduleIds), ...(!queriedRows.loading && result?.scope === statusScope() ? result.rows : [])]
  }
  const runAction = (action: ModuleRowAction) => {
    if (!props.docked) client.closeSheet()
    if (action.kind === "command") client.actions.invokeCommand(action.id)
    else client.openSurface(action.id)
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
      .then(() => client.report("info", "Copied."))
      .catch((cause: unknown) => client.report("warning", `Could not copy: ${describeFailure(cause)}`))
  }

  const scopedBudget = createMemo(() => {
    const detailBudget = facts()?.detail?.budget
    return detailBudget === undefined || detailBudget === null ? detailBudget : state().budget
  })
  const spend = createMemo(() => spendReading(scopedBudget()))
  const sessionFacts = () => {
    const view = facts()?.detail
    if (!view) return undefined
    const budget = scopedBudget()
    return [
      // A live session has a runner, which waits for input between turns. It
      // is working only while a turn runs, as the session dot shows.
      view.source !== "live" ? "loaded from history" : state().busy ? "working" : "open",
      "conversation",
      budget === null || budget === undefined
        ? undefined
        : budget.totalsLoading ? "totals loading" : `${budget.totalTokens.toLocaleString()} tokens`,
    ].filter((part) => part !== undefined).join(" · ")
  }
  const sessionFactsBusy = () => scopedBudget()?.totalsLoading === true
  const roleFacts = () => {
    const roles = facts()?.roles
    if (!roles) return undefined
    return Object.entries(roles.assignments).map(([role, assignment]) => `${role}: ${assignment.model}`).join("\n")
  }

  return (
    <WorkspaceSurface title={KERNEL_COMMAND_NAMES.status} docked={props.docked} onClose={props.onClose ?? client.closeSheet}>
      <Show when={!facts.loading} fallback={<SheetLoading />}>
        <div class="sheet-section">This chat</div>
        <Show when={state().sessionId} fallback={<SheetRow label="No chat selected" />}>
          {(sessionId) => (
            <SheetRow label="Session" detail={sessionFacts()} value={sessionId().slice(0, 8)} detailBusy={sessionFactsBusy()} onClick={() => copy(sessionId())} />
          )}
        </Show>
        <Show when={state().settings?.seatModel}>{(model) => <SheetRow label="Model" value={model()} onClick={() => client.openSheet("model")} />}</Show>
        <Show when={roleFacts()}>{(roles) => <SheetRow label="Roles" detail={roles()} onClick={() => client.openSheet("models")} />}</Show>
        <Show when={spend()}>
          {(reading) => <SheetRow label="Spend" value={reading().value} detail={reading().detail} valueBusy={reading().busy} />}
        </Show>
        <Show when={state().executionCwd}>{(cwd) => <SheetRow label="Working directory" detail={cwd()} onClick={() => copy(cwd())} />}</Show>

        <div class="sheet-section">Project</div>
        <SheetRow label="Sessions" value={`${state().sessions.filter((session) => session.active).length} open · ${state().sessions.length} total`} onClick={() => client.openSheet("sessions")} />
        <Show when={state().projectRoot}>{(root) => <SheetRow label="Project root" detail={root()} onClick={() => copy(root())} />}</Show>
        <Key each={rows()} by="id">{(row) => <ModuleRowView row={row()} onAction={runAction} />}</Key>

        <div class="sheet-section">Application</div>
        <Show when={state().update}>{(update) => <SheetRow label="Updates" value={describeUpdateStatus(update().status)} detail={update().autoInstall.effective ? "Automatic updates on" : "Automatic updates are off"} onClick={() => client.openSheet("settings")} />}</Show>
        {/* One version: the runtime serves this client and refuses any other build. */}
        <Show when={state().runtimeVersion}>{(version) => <SheetRow label="Version" value={`Flywheel ${version()}`} />}</Show>
        <SheetRow label="Runtime" value={runtime().value} detail={runtime().detail} tone={runtime().tone} working={client.actions.working(actionKey("reconnect"))} disabled={!runtime().reconnect} onClick={() => { if (runtime().reconnect) client.actions.reconnect() }} />
        <Show when={state().sessionId}>
          {(sessionId) => <SheetRow label="Debug" detail={`flywheel events search --session ${sessionId()} --errors`} onClick={() => copy(`flywheel events search --session ${sessionId()} --errors`)} />}
        </Show>
      </Show>
    </WorkspaceSurface>
  )
}

/** The runtime row. Its tone follows the one runtime notice, so a lost
 *  runtime and a failed recovery read as the same fault and a restart as a
 *  warning. Only a runtime that does not answer offers a reconnect; a
 *  runtime that answers while its background service keeps stopping soon
 *  after it starts, while it restarts the project's process, or after it
 *  could not restore its sessions, says so with nothing to click. */
interface RuntimeReading {
  readonly value: string
  readonly detail?: string
  readonly tone: "ok" | "warn" | "error"
  /** Only a runtime that does not answer can be reconnected to. */
  readonly reconnect: boolean
}

function runtimeReading(health: RuntimeHealth): RuntimeReading {
  if (health.kind === "healthy") return { value: "answering", tone: "ok", reconnect: false }
  const tone = runtimeFaultCopy(health).tone === "fault" ? "error" : "warn"
  switch (health.kind) {
    case "faulted": return { value: "not answering", tone, reconnect: true }
    case "crash_loop": return { value: "answering", detail: "The background service keeps stopping soon after it starts", tone, reconnect: false }
    case "restarting": return { value: "answering", detail: "Restarting this project's process", tone, reconnect: false }
    case "recovery_failed": return { value: "answering", detail: "Could not restore this project's sessions", tone, reconnect: false }
  }
}

function spendReading(budget: BudgetSummary | null | undefined): { readonly value: string; readonly detail?: string; readonly busy?: true } | undefined {
  if (budget === null || budget === undefined) return undefined
  if (budget.totalsLoading) return { value: "totals loading", busy: true }
  return {
    value: `${budget.totalTokens.toLocaleString()} tokens · ${budget.priceUnavailable ? "price unavailable" : budget.cost === 0 ? "no usage" : `$${budget.cost.toFixed(2)}`}`,
    detail: `${Math.round(budget.contextPercent)}% of the context window in use${budget.priceUnavailable ? " · Cost total is incomplete" : budget.billedCost > 0 ? ` · $${budget.billedCost.toFixed(2)} billed, the rest covered by a subscription` : ""}`,
  }
}
