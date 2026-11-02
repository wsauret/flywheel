import { createSignal, For, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { webModuleEnabled, type WebModule } from "../web-module.js"

import { pageDomainReader } from "../client/module-domain-views.js"
import { moduleComposerStatus } from "../../../src/protocol/modules.js"
import { protocolModuleComposerStatus, type ModuleComposerStatus, type ProtocolModule } from "../../../src/protocol/protocol-module.js"
import { runtimeFaultCopy, type FaultReach } from "../../../src/protocol/client/runtime-fault-copy.js"
import { useClient } from "./client-context.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"

/** The runtime's one notice, when there is one: a lost runtime, or an
 *  executor the runtime keeps restarting. It is a sentence with a remedy,
 *  so it takes a row of its own under the toolbar and wraps there, instead
 *  of a chip that a narrow panel cuts off. Recovery from a dropped
 *  connection shows nothing. `reach` is how the page reaches its runtime,
 *  which its host presence states: a page that reaches it through the relay
 *  names the chosen machine, and says that it is asleep while the relay
 *  reports it offline, as its machine list does. */
export function RuntimeFaultNotice(props: { readonly reach?: FaultReach | undefined; readonly modules?: readonly WebModule[] }) {
  const client = useClient()
  const reads = backgroundReads(client.connection)
  const [failing, setFailing] = createSignal(reads.failing)
  onCleanup(reads.subscribe(() => setFailing(reads.failing)))
  return <Show when={(() => { const health = client.state().health; return health.kind === "healthy" ? null : runtimeFaultCopy(health, props.reach) })()} fallback={
    <Show when={failing()}><p class="runtime-fault" role="status">Some views could not load. Flywheel keeps trying.</p></Show>
  }>
    {(fault) => <p class={`runtime-fault runtime-fault-${fault().tone}`} role="status" title={fault().detail}>{fault().title} {fault().remedy}
      <For each={props.modules ?? []}>{(module) => <Show when={webModuleEnabled(module.id, client.state().settings?.moduleIds) && module.runtimeFaultDetail}>{(Detail) => <Dynamic component={Detail()} health={client.state().health} />}</Show>}</For>
    </p>}
  </Show>
}

/** The enabled modules' composer labels, as chips in the toolbar. */
export function ComposerStatus(props: { readonly modules?: readonly ProtocolModule[] }) {
  const client = useClient()
  const labels = () => {
    const read = pageDomainReader(client.state)
    const enabled = client.state().settings?.moduleIds
    return props.modules === undefined ? moduleComposerStatus(read, enabled, "webview") : protocolModuleComposerStatus(props.modules, read, enabled, "webview")
  }
  const run = (label: ModuleComposerStatus) => {
    if (label.action?.kind === "surface") client.openSurface(label.action.id)
    else if (label.action?.kind === "command") client.actions.invokeCommand(label.action.id)
  }
  return <>
    <For each={labels()}>{(label) => {
      const text = () => <>{label.text}<Show when={label.suffix}>{(suffix) => <> <span class={`connection-${suffix().tone ?? "plain"}`}>{suffix().text}</span></>}</Show></>
      return <Show when={label.action} fallback={<span class={`connection connection-${label.tone ?? "plain"}`} data-module-status={label.id}>{text()}</span>}>
        <button class={`connection connection-${label.tone ?? "plain"}`} data-module-status={label.id} aria-busy={(label.action?.kind === "command" && client.actions.commandWorking(client.state().sessionId, label.action.id)) || undefined} onClick={() => run(label)}>{text()}</button>
      </Show>
    }}</For>
  </>
}
