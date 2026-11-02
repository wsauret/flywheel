import { createEffect, createMemo, createResource, createSignal, on, onCleanup, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { ProviderModelTarget, ProviderModelView } from "../../../../src/protocol/provider-model-preference-protocol-types.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { useClient } from "../client-context.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "./sheet.js"

/** Which models from a connected provider Flywheel may use.
 *
 *  Providers publish more models than an account is entitled to, and some are
 *  opt-in. This list decides what appears when a person chooses a model for a
 *  role. The exact account is chosen first, because a subscription provider
 *  can hold several and each has its own catalog. */

interface TargetChoice {
  readonly label: string
  readonly detail?: string
  readonly target: ProviderModelTarget
}

/** The one account a target names, as text. */
function targetId(target: ProviderModelTarget): string {
  return target.kind === "subscription" ? `${target.providerId}:${target.accountCorrelationId}` : target.providerId
}

function sameTarget(left: ProviderModelTarget, right: ProviderModelTarget): boolean {
  if (left.kind !== right.kind || left.providerId !== right.providerId) return false
  return left.kind !== "subscription" || right.kind !== "subscription" || left.accountCorrelationId === right.accountCorrelationId
}

/** The surviving id closest to `lost` in the previous order, preferring the row that followed it. */
function nearestSurvivor(previous: readonly string[], lost: string, survivors: ReadonlySet<string>): string | undefined {
  const origin = previous.indexOf(lost)
  for (let distance = 1; distance < previous.length; distance += 1) {
    for (const candidate of [previous[origin + distance], previous[origin - distance]]) {
      if (candidate !== undefined && survivors.has(candidate)) return candidate
    }
  }
  return [...survivors][0]
}

/** The connected accounts whose catalog can be edited, one row per exact target. */
function targetsOf(providers: readonly AuthProviderStatus[]): readonly TargetChoice[] {
  return providers.flatMap((provider): readonly TargetChoice[] => {
    if (provider.group !== "model" || (provider.source !== "stored_key" && provider.source !== "oauth")) return []
    if (provider.kind === "singleton") return [{ label: provider.displayName, target: { kind: "singleton", providerId: provider.providerId } }]
    if (provider.kind !== "subscription") return []
    return provider.accounts.map((account) => ({
      label: provider.displayName,
      detail: account.label ?? account.displayLabel,
      target: { kind: "subscription", providerId: provider.providerId, accountCorrelationId: account.accountCorrelationId },
    }))
  })
}

export function ProviderModelsSheet() {
  const client = useClient()
  const authStatus = createMemo(() => client.state().authStatus, undefined, {
    equals: (left, right) => left?.snapshotPosition === right?.snapshotPosition,
  })
  const auth = () => authStatus()?.auth
  const activeProfileId = createMemo(() => auth()?.profile.id)
  createEffect(on(activeProfileId, (id) => {
    if (id === undefined) return
    void client.connection.dispatch({ type: "auth.catalog.refresh", scope: { kind: "profile", profileId: id } })
      .catch((cause: unknown) => client.report("warning", `Flywheel could not refresh models: ${describeFailure(cause)}`))
  }))
  const targets = createMemo(() => targetsOf(auth()?.providers ?? []))
  const [chosen, setChosen] = createSignal<TargetChoice | undefined>(undefined)
  createEffect(on(activeProfileId, () => setChosen(undefined), { defer: true }))
  // One target needs no question.
  const target = () => chosen() ?? (targets().length === 1 ? targets()[0] : undefined)
  const account = createMemo(() => {
    const profileId = auth()?.profile.id
    const current = target()
    return profileId === undefined || current === undefined
      ? undefined
      : { profileId, target: current.target }
  }, undefined, {
    equals: (left, right) => left === right || (left !== undefined && right !== undefined &&
      left.profileId === right.profileId && sameTarget(left.target, right.target)),
  })
  const querySource = createMemo(() => {
    const current = account()
    return current && { ...current, eligibilityRevision: auth()?.autoEnableNewModels?.eligibilityRevision }
  }, undefined, {
    equals: (left, right) => left === right || (left !== undefined && right !== undefined &&
      left.profileId === right.profileId && left.eligibilityRevision === right.eligibilityRevision && sameTarget(left.target, right.target)),
  })
  let latestRead: Promise<ProviderModelView>
  let disposed = false
  onCleanup(() => { disposed = true })
  const [view, { refetch }] = createResource(querySource, async ({ profileId, target: current }, previous): Promise<ProviderModelView> => {
    latestRead = client.connection.query({ type: "provider_models.query", profileId, target: current })
    try {
      return await latestRead
    } catch (cause) {
      const held = previous.value
      if (held?.profileId === profileId && sameTarget(held.target, current)) {
        client.report("warning", `Flywheel could not refresh the model list: ${describeFailure(cause)}`)
        return held
      }
      throw cause
    }
  })
  const visible = () => {
    if (view.error !== undefined) return undefined
    const current = target()?.target
    const latest = view.latest
    if (!current || !latest || latest.profileId !== auth()?.profile.id) return undefined
    if (!sameTarget(latest.target, current)) return undefined
    return latest
  }

  /** The newest read for `origin`, or undefined when the account changed or the sheet closed while waiting. */
  const freshView = async (origin: ReturnType<typeof account>): Promise<ProviderModelView | undefined> => {
    let read: Promise<ProviderModelView>
    let fresh: ProviderModelView
    do {
      read = latestRead
      fresh = await read
      if (disposed || account() !== origin) return undefined
    } while (read !== latestRead)
    return fresh
  }

  const reportFailure = (cause: unknown) => {
    const message = describeFailure(cause)
    if (message.includes("stale provider-model preference mutation") || message.includes("auth profile inputs changed during provider-model preference mutation")) {
      void refetch()
      client.report("warning", "Model access changed. The list was refreshed; review it and try again.")
    } else client.report("warning", `Flywheel could not change the model list: ${message}`)
  }

  // Every write to one account's list states the revision it read, and each
  // write moves that revision on. So the writes of one account run in order
  // under one queue, each after the one before it has read the list again.
  const writes = () => { const current = account(); return actionKey("provider-models", current?.profileId, current && targetId(current.target)) }
  const rowKey = (modelId: string) => { const current = account(); return actionKey("provider-model", current?.profileId, current && targetId(current.target), modelId) }
  const recheckKey = () => { const current = account(); return actionKey("provider-models-recheck", current?.profileId, current && targetId(current.target)) }

  const toggle = (modelId: string, checked: boolean) => {
    const current = visible()
    if (!current) return
    const origin = account()
    const apply = async () => {
      const fresh = await freshView(origin)
      if (!fresh) return
      if (fresh.profileId !== current.profileId || !sameTarget(fresh.target, current.target)) return
      const row = fresh.rows.find((candidate) => candidate.modelId === modelId)
      if (!row || (!row.optInAvailable && !checked)) {
        client.report("warning", row?.unavailableReason ?? `${modelId} is not available on this account.`)
        return
      }
      await client.connection.dispatch({
        type: "provider_model.set",
        queriedProfileId: fresh.profileId,
        queriedEligibilityRevision: fresh.eligibilityRevision,
        target: fresh.target,
        modelId,
        checked: !checked,
      })
      if (!disposed && account() === origin) await refetch()
    }
    void client.actions.runInOrder(writes(), rowKey(modelId), apply, reportFailure)
  }

  const canRecheck = () => visible()?.recheckAvailable === true
  const canGoBack = () => chosen() !== undefined && targets().length > 1

  /** Probes every candidate of this exact account again, even when all were refused. Rows the server refuses disappear through the next read. */
  const recheck = () => {
    if (!canRecheck()) return
    const origin = account()
    const apply = async () => {
      const fresh = await freshView(origin)
      if (!fresh || fresh.recheckAvailable !== true) return
      await client.connection.dispatch({
        type: "provider_models.recheck",
        queriedProfileId: fresh.profileId,
        queriedEligibilityRevision: fresh.eligibilityRevision,
        target: fresh.target,
      })
      if (!disposed && account() === origin) await refetch()
    }
    void client.actions.runInOrder(writes(), recheckKey(), apply, reportFailure)
  }

  // A removed row must not strand the keyboard: focus moves to the nearest row that survived.
  const rowElements = new Map<string, HTMLElement>()
  let recheckElement: HTMLButtonElement | undefined
  let focusedModelId: string | undefined
  let renderedModelIds: readonly string[] = []
  createEffect(() => {
    const ids = (visible()?.rows ?? []).map((row) => row.modelId)
    const lost = focusedModelId
    if (lost !== undefined && !ids.includes(lost)) {
      const next = nearestSurvivor(renderedModelIds, lost, new Set(ids))
      focusedModelId = next
      const element = next === undefined ? recheckElement : rowElements.get(next)
      element?.focus({ preventScroll: true })
      element?.scrollIntoView({ block: "nearest" })
    }
    renderedModelIds = ids
  })
  const registerRow = (modelId: string, element: HTMLElement) => {
    rowElements.set(modelId, element)
    element.addEventListener("focus", () => { focusedModelId = modelId })
    element.addEventListener("blur", (event) => { if (event.relatedTarget !== null && focusedModelId === modelId) focusedModelId = undefined })
    onCleanup(() => { if (rowElements.get(modelId) === element) rowElements.delete(modelId) })
  }

  return (
    <Sheet
      title={target() === undefined ? "Which account?" : `${target()!.label} models`}
      onClose={client.closeSheet}
      tools={<Show when={canRecheck() || canGoBack()}>
        <Show when={canRecheck()}><button ref={(element) => { recheckElement = element }} class="ghost-text" aria-busy={client.actions.working(recheckKey()) || undefined} onClick={recheck}>Recheck access</button></Show>
        <Show when={canGoBack()}><button class="ghost-text" onClick={() => setChosen(undefined)}>Back</button></Show>
      </Show>}
    >
      <Show when={auth()} fallback={<SheetLoading />}>
        <Show when={target()} fallback={
          <Show when={targets().length > 0} fallback={<SheetEmpty>Connect a provider first.</SheetEmpty>}>
            <Key each={targets()} by={(choice) => targetId(choice.target)}>
              {(choice) => <SheetRow label={choice().label} detail={choice().detail} onClick={() => setChosen(choice())} />}
            </Key>
          </Show>
        }>
          <Show when={!view.loading || visible() !== undefined} fallback={<SheetLoading />}>
            <Show when={view.error === undefined || visible() !== undefined} fallback={<SheetEmpty>Could not read the catalog: {describeFailure(view.error)}</SheetEmpty>}>
              <Show when={(visible()?.audit?.remaining ?? 0) > 0}>
                <div class="sheet-section">{visible()?.audit?.remaining} access check{visible()?.audit?.remaining === 1 ? "" : "s"} pending</div>
              </Show>
              <Show when={(visible()?.rows.length ?? 0) > 0} fallback={<SheetEmpty>{(visible()?.audit?.refused ?? 0) > 0 ? "No models are currently available for this account. Recheck access to try again." : `${visible()?.providerDisplayName ?? "This provider"} publishes no selectable models.`}</SheetEmpty>}>
                <div class="sheet-section">Pick one to turn it on or off</div>
                <Key each={visible()?.rows ?? []} by={(row) => row.modelId}>
                  {(row) => (
                    <SheetRow
                      rowRef={(element) => registerRow(row().modelId, element)}
                      label={<>{row().checked ? "✓ " : ""}{row().modelId}</>}
                      detail={row().unavailableReason ?? (row().accessState === "pending" ? "Access pending" : row().optInAvailable ? undefined : "not available on this account")}
                      tone={row().unavailableReason === undefined && (row().optInAvailable || row().checked) ? undefined : "warn"}
                      working={client.actions.working(rowKey(row().modelId))}
                      onClick={() => toggle(row().modelId, row().checked)}
                    />
                  )}
                </Key>
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </Sheet>
  )
}
