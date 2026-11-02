import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { ClientContextValue } from "../../app/client-context.js"
import { enablePush } from "./push-actions.js"

const registrations = new WeakMap<ClientContextValue, ReturnType<typeof createPushRegistration>>()

/** The notice owns registration for this client mount; menus only read it. */
export const pushRegistration = (client: ClientContextValue) => registrations.get(client)

function readDismissed(key: string | undefined): number | undefined {
  try {
    const value: unknown = JSON.parse(key ? localStorage.getItem(key) ?? "null" : "null")
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function writeDismissed(key: string | undefined, timestamp: number | undefined): void {
  if (!key) return
  try {
    if (timestamp !== undefined) localStorage.setItem(key, JSON.stringify(timestamp))
    else localStorage.removeItem(key)
  } catch {
    // A browser that refuses storage shows the offer again after a relaunch.
  }
}

export type PushGuideState =
  | { readonly kind: "loading" | "install" | "permission" | "denied" | "on" | "unavailable" }
  | { readonly kind: "failed"; readonly message?: string }
  | { readonly kind: "move"; readonly machine?: string }

/** Reconciles browser permission and subscription with the selected runtime.
 *  A mismatched VAPID key requires a tap; repair under the same key does not. */
export function createPushRegistration(client: ClientContextValue) {
  const [state, setState] = createSignal<PushGuideState>({ kind: "loading" })
  const [busy, setBusy] = createSignal(false)
  const push = client.host.capabilities.push
  const remoteHost = client.host.capabilities.remote
  const [snapshot, setSnapshot] = createSignal(remoteHost?.snapshot())
  // A permission prompt can outlive a menu, but not the guide's app mount.
  const operation = new AbortController()
  onCleanup(() => operation.abort())
  if (remoteHost) onCleanup(remoteHost.onChange(setSnapshot))
  // Selection publishes before the old placement unmounts. Its saved state
  // must stay with this mount, including when the first choice arrives late.
  const dismissalKey = createMemo<string | undefined>((bound) => {
    if (bound !== undefined) return bound
    const selected = snapshot()?.selected
    return selected ? `flywheel.push-guide.dismissed:${JSON.stringify([selected.runtimeId, selected.placementId])}` : undefined
  })
  const [dismissedAt, setDismissedAt] = createSignal(readDismissed(dismissalKey()))
  const remember = (timestamp: number | undefined) => {
    setDismissedAt(timestamp)
    writeDismissed(dismissalKey(), timestamp)
  }
  createEffect(on(dismissalKey, (key) => setDismissedAt(readDismissed(key))))
  let version = 0
  let forwarded = false
  const failed = (error: unknown) => {
    if (operation.signal.aborted) return
    client.host.onDiagnostic?.("push registration failed", { errorName: error instanceof Error ? error.name : "UnknownError", permission: push?.state() })
    setState({ kind: "failed" })
  }
  const enable = async () => {
    const remote = client.state().modules.remote
    if (!remote || busy() || operation.signal.aborted) return
    if (push?.state() === "unavailable") { setState({ kind: "unavailable" }); return }
    if (push?.state() === "denied") { setState({ kind: "denied" }); return }
    ++version
    setBusy(true)
    try {
      const outcome = await enablePush(client.connection, client.host.capabilities, remote, operation.signal)
      if (operation.signal.aborted) return
      if (outcome.kind === "on") { forwarded = true; setState({ kind: "on" }) }
      else if (push?.state() === "denied") setState({ kind: "denied" })
      else if (outcome.kind === "declined") setState({ kind: "permission" })
      else if (outcome.kind === "rejected") setState({ kind: "failed", message: outcome.message })
    } catch (error) { failed(error) } finally { setBusy(false) }
  }
  const refresh = async (renewed = false) => {
    if (!push || !remoteHost || busy() || operation.signal.aborted) return
    const remote = client.state().modules.remote
    if (!remote?.pushPublicKey) return
    const currentVersion = ++version
    if (snapshot()?.install) { setState({ kind: "install" }); return }
    const permission = push.state()
    if (permission !== "granted") {
      setState({ kind: permission === "denied" ? "denied" : permission === "default" ? "permission" : "unavailable" })
      return
    }
    try {
      const subscription = await push.current()
      if (currentVersion !== version || operation.signal.aborted) return
      if (subscription && subscription.applicationServerKey !== remote.pushPublicKey) {
        const machine = snapshot()?.runtimes.find((runtime) => runtime.runtimeId === subscription.runtimeId)?.label
        setState({ kind: "move", machine })
        return
      }
      const recorded = remote.devices.some((device) => device.id === remoteHost.deviceId && device.notifies)
      if (renewed || !subscription || !recorded || !forwarded) {
        await enable()
      }
      else setState({ kind: "on" })
    } catch (error) { if (currentVersion === version) failed(error) }
  }
  createEffect(on(() => {
    const remote = client.state().modules.remote
    return `${remote?.pushPublicKey}:${remote?.devices.find((device) => device.id === remoteHost?.deviceId)?.notifies}:${snapshot()?.install !== undefined}`
  }, () => { void refresh() }))
  if (push?.onChange) onCleanup(push.onChange(() => { void refresh(true) }))
  onCleanup(client.connection.subscribe((event) => {
    if (event.type === "patch" && event.patch.payload.kind === "question.updated") {
      void refresh()
    }
  }))
  createEffect(on(() => [dismissalKey(), client.state().newestQuestionOpenedAt, state().kind] as const, ([, openedAt, kind]) => {
    const remembered = dismissedAt()
    // Phone and machine clock skew can shift when a question counts as newer.
    if (remembered === undefined || openedAt === undefined || openedAt <= remembered || kind === "loading") return
    // A question this phone was notified of does not reopen the offer later.
    if (kind === "on") remember(openedAt)
    else {
      remember(undefined)
      void refresh()
    }
  }))
  const registration = {
    state, busy, dismissed: () => dismissedAt() !== undefined,
    dismiss: () => remember(Date.now()),
    enable, snapshot,
  }
  registrations.set(client, registration)
  onCleanup(() => registrations.delete(client))
  return registration
}

