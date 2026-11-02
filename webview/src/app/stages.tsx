import { Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { everyProviderOff } from "../../../src/protocol/client/capabilities.js"
import type { ProviderSummary } from "../../../src/protocol/client/provider-summary.js"
import { useClient } from "./client-context.js"
import { BrandTile, Mark } from "./icons.js"
import type { PlacementLabels } from "./screen-stack.js"

/** The stages that replace the panel or the transcript pane wholesale:
 *  starting, opening a destination, and setup. They are the whole surface
 *  rather than a notice, because until they resolve there is nothing behind
 *  them a person could use. */

/** What this provider needs from the user, in the fewest words that are still
 *  true. "Not connected" is not enough: a rejected key, a lapsed sign-in and a
 *  broken config entry each need a different action. */
function describeProvider(provider: ProviderSummary): string {
  if (provider.source === "misconfigured") return provider.detail ?? "check your Flywheel config"
  if (provider.source === "invalid") return "credential rejected, sign in again"
  if (provider.expired) return "signed out, sign in again"
  if (provider.loginMethod === "api-key") return "paste an API key"
  if (provider.loginMethod === "device-code") return "sign in with a code"
  return "sign in with your browser"
}

/** The loading screen: the icon that was just tapped, its mark turning, and
 *  the name of what is opening when the host knows it. A phone that remembers
 *  its machine lands here for the second presence takes and then straight on
 *  the session, so nothing on it asks for anything. */
export function StartingStage(props: { readonly placement?: PlacementLabels | undefined }) {
  return (
    <div class="stage stage-starting" role="status" aria-label="Starting Flywheel">
      <BrandTile size={96} markClass="brand-mark" />
      <div class="stage-title">Flywheel</div>
      {/* The project alone: a machine is named after the project it was
          paired from, so naming both reads as the same word twice. */}
      <Show when={props.placement} fallback={<p class="stage-body">Opening this project.</p>}>
        {(placement) => <p class="stage-body">Opening {placement().project}.</p>}
      </Show>
    </div>
  )
}

/** The pane between a tap and its destination: the turning mark and the name
 *  of what opens, so the tap visibly landed while the content loads. A failed
 *  open shows the still mark, the cause, and Try again, in the same place:
 *  the still mark says the machine now waits on the person. */
export function OpeningStage(props: { readonly name?: string | undefined; readonly failure?: string | undefined; readonly onRetry: () => void }) {
  return (
    <div class="stage stage-starting stage-opening" role="status" aria-busy={props.failure === undefined || undefined}>
      <Show when={props.failure} fallback={<BrandTile size={64} markClass="brand-mark" />}>
        <Mark />
      </Show>
      <div class="stage-title">{props.name ?? "Opening this session"}</div>
      <Show when={props.failure} fallback={<p class="stage-body">Loading…</p>}>
        {(failure) => (
          <>
            <p class="stage-body">{failure()}</p>
            {/* No working state of its own: the tap turns this pane back into
                the loading screen at once. */}
            <button class="primary" onClick={() => props.onRetry()}>Try again</button>
          </>
        )}
      </Show>
    </div>
  )
}

export function NeedsProviderStage() {
  const client = useClient()
  const providersOff = () => {
    const view = client.state().settings?.capabilities
    return view !== undefined && everyProviderOff(view)
  }
  return (
    <div class="stage">
      <Mark />
      <div class="stage-title">Connect a model provider</div>
      <p class="stage-body">
        Sign in with a subscription you already pay for, or paste an API key. Connect more than
        one and Flywheel rotates between them when a cap is hit, so a turn does not just stop.
      </p>
      <p class="stage-body">This is the only setup step.</p>
      {/* Minimal turns every provider module off, so the list below is empty:
          the way back is the switch that turns one on. */}
      <Show when={providersOff()}>
        <div class="provider-list">
          <button class="provider" onClick={() => client.openSheet("capabilities")}>
            <span class="provider-name">Capabilities</span>
            <span class="provider-how">every model provider is turned off</span>
            <span class="provider-go" aria-hidden="true">›</span>
          </button>
        </div>
      </Show>
      <div class="provider-list">
        <Key each={client.state().providers} by="id">
          {(provider) => (
            <button class="provider" onClick={() => client.openSheet("providers", { kind: "connect-provider", providerId: provider().id })}>
              <span class="provider-name">{provider().displayName}</span>
              <span class="provider-how" classList={{ warn: provider().source === "misconfigured" }}>{describeProvider(provider())}</span>
              <span class="provider-go" aria-hidden="true">›</span>
            </button>
          )}
        </Key>
      </div>
      <p class="stage-note">
        You can add or change providers later in Authentication.{" "}
        <Show when={client.actions.hasHostCommand("flywheel.showWelcome")}>
          <button class="link" onClick={() => client.actions.runHostCommand("flywheel.showWelcome")}>How Flywheel works</button>
        </Show>
      </p>
    </div>
  )
}
