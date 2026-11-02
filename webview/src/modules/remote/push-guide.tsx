import { Match, Show, Switch } from "solid-js"
import { useClient } from "../../app/client-context.js"
import { InstallGuide } from "./install-guide.js"
import { createPushRegistration } from "./push-registration.js"
import "./install-guide.css"

export function PushGuide(props: { readonly visible: boolean }) {
  const client = useClient()
  if (!client.host.capabilities.remote) return null
  const registration = createPushRegistration(client)
  const selectedMachine = () => {
    const current = registration.snapshot()
    return current?.runtimes.find((runtime) => runtime.runtimeId === current.selected?.runtimeId)?.label
  }
  return <Show when={props.visible && !registration.dismissed() && registration.state().kind !== "on" && registration.state().kind !== "loading"}>
    <div class="push-guide">
    <Switch>
      <Match when={registration.state().kind === "install"}>
        <Show when={registration.snapshot()?.install}>{(guide) => <InstallGuide guide={guide()} onPrompt={client.host.capabilities.remote?.promptInstall} onDismiss={registration.dismiss} forceVisible />}</Show>
      </Match>
      <Match when={registration.state().kind !== "install"}>
        <section class="install-guide" aria-label="Phone notifications">
          <h3 class="install-title">Notifications</h3>
          <p class="install-lead">
            <Switch>
              <Match when={registration.state().kind === "permission"}>Turn on notifications so this phone tells you when a chat needs you.</Match>
              <Match when={registration.state().kind === "denied"}>This phone blocks notifications from Flywheel. {client.host.capabilities.push?.settingsInstructions ?? "Allow them for Flywheel in this phone's settings."}</Match>
              <Match when={registration.state().kind === "move"}>{(() => {
                const state = registration.state()
                return state.kind === "move" ? `This phone gets notifications from ${state.machine ?? "another machine"}. Get them from ${selectedMachine()} instead.` : ""
              })()}</Match>
              <Match when={registration.state().kind === "unavailable"}>This browser cannot show notifications.</Match>
              <Match when={registration.state().kind === "failed"}>{(() => {
                const state = registration.state()
                return state.kind === "failed" ? state.message ?? "Notifications could not be turned on. Try Turn on again." : ""
              })()}</Match>
            </Switch>
          </p>
          <div class="install-actions">
            <button class="ghost-text" onClick={registration.dismiss}>Later</button>
            <Show when={registration.state().kind !== "denied" && registration.state().kind !== "unavailable"}>
              <button class="primary" disabled={registration.busy()} onClick={() => { void registration.enable() }}>
                {registration.busy() ? "Turning on…" : registration.state().kind === "move" ? `Get notifications from ${selectedMachine()}` : "Turn on"}
              </button>
            </Show>
          </div>
        </section>
      </Match>
    </Switch>
    </div>
  </Show>
}
