import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import QRCode from "qrcode"

import { lingerNotice } from "../../../../src/protocol/client/process-initiation-copy.js"
import { remoteDomain, REMOTE_COMMAND_NAME } from "../../../../src/protocol/modules/remote.js"
import { useClient } from "../../app/client-context.js"
import { pageDomainReader } from "../../client/module-domain-views.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "../../app/sheets/sheet.js"
import { SheetField } from "../../app/sheets/controls.js"
import { createRemoteMutation, type RemoteMutation } from "./mutation.js"
import "./sheet.css"

/** The runtime's remote view, including a read-only view in restricted hosts. */
export function RemoteSheet() {
  const client = useClient()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const projectRoot = client.state().projectRoot
  const active = () => !controller.signal.aborted && client.state().projectRoot === projectRoot && client.state().settings?.moduleIds.includes("remote") !== false
  const read = pageDomainReader(client.state)
  const view = () => read(remoteDomain)
  const allowed = (type: RemoteMutation["type"]) => client.host.capabilities.canMutate?.(type) !== false
  const { mutate, working } = createRemoteMutation({
    dispatch: (mutation) => client.connection.dispatch(mutation),
    report: (severity, message) => client.report(severity, message),
    actions: client.actions,
  }, active, allowed)
  return (
    <Sheet title={REMOTE_COMMAND_NAME} onClose={client.closeSheet}>
      <Show when={view()} fallback={<SheetLoading />}>
        {(remote) => <Show when={remote().pairing} fallback={
          <>
            <Show when={remote().lastError}>{(message) => <div class="sheet-problem">{message()}</div>}</Show>
            <Show when={remote().processInitiation}>{(processInitiation) => <SheetRow label="Process initiation" value={processInitiation()} tone={processInitiation() === "unavailable" ? "warn" : undefined} detail={<>
              {processInitiation() === "unavailable"
                ? allowed("remote.process_initiation.set")
                  ? "Flywheel could not read the installed service state. Repair registers and starts the service."
                  : "Flywheel could not read the installed service state. Run `flywheel serve install` on this machine. If that command also fails, report a bug."
                : allowed("remote.process_initiation.set") ? "A paired phone can start Flywheel for a known project while the machine is awake."
                  : `On the machine, run flywheel serve ${processInitiation() === "on" ? "uninstall" : "install"} to turn this ${processInitiation() === "on" ? "off" : "on"}.`}
              <Show when={remote().lingerOffFor}>{(user) => <span class="remote-notice warn">{lingerNotice(user())}</span>}</Show>
            </>}>
              <Show when={allowed("remote.process_initiation.set")}>
                <button class="secondary" aria-busy={working("remote.process_initiation.set") || undefined} onClick={() => { void mutate({ type: "remote.process_initiation.set", enabled: processInitiation() !== "on" }, processInitiation() === "unavailable") }}>{processInitiation() === "unavailable" && working("remote.process_initiation.set") ? "Repairing…" : processInitiation() === "unavailable" ? "Repair" : processInitiation() === "on" ? "Turn off" : "Turn on"}</button>
              </Show>
            </SheetRow>}</Show>
            <Show when={allowed("remote.pair.open")}><button class="secondary" aria-busy={working("remote.pair.open") || undefined} onClick={() => { void mutate({ type: "remote.pair.open" }) }}>Pair a device</button></Show>
            <div class="sheet-section">Paired devices</div>
            <Show when={remote().devices.length > 0} fallback={<SheetEmpty>No paired devices.</SheetEmpty>}>
              <Key each={remote().devices} by="id">{(device) => <SheetRow label={
                <Show when={allowed("remote.device.rename")} fallback={device().label}><SheetField label="Device name" value={device().label}
                  working={working("remote.device.rename", device().id)}
                  validate={(label) => label.trim() ? undefined : "Enter a name."}
                  onCommit={(label) => mutate({ type: "remote.device.rename", deviceId: device().id, label: label.trim() })} /></Show>
              } value={device().attached ? "attached" : "not attached"} detail={`Paired ${new Date(device().pairedAt).toLocaleDateString()}`}>
                <Show when={allowed("remote.device.revoke")}><button class="ghost" aria-busy={working("remote.device.revoke", device().id) || undefined} onClick={() => {
                  void client.confirm({ title: `Unpair ${device().label}?`, confirmLabel: "Unpair", destructive: true }, controller.signal).then((confirmed) => { if (confirmed) void mutate({ type: "remote.device.revoke", deviceId: device().id }) })
                }}>Unpair</button></Show>
              </SheetRow>}</Key>
            </Show>
            <div class="sheet-section">Projects</div>
            <Key each={remote().projects} by="placementId">{(project) => <SheetRow label={project().projectLabel} value={project().state} detail={project().displayPath}>
              <Show when={allowed("remote.project.forget")}><button class="ghost" aria-busy={working("remote.project.forget", project().placementId) || undefined} onClick={() => {
                void client.confirm({ title: `Forget ${project().projectLabel}?`, detail: "Opening this project on the machine while paired offers it again.", confirmLabel: "Forget", destructive: true }, controller.signal).then((confirmed) => { if (confirmed) void mutate({ type: "remote.project.forget", placementId: project().placementId }) })
              }}>Forget</button></Show>
            </SheetRow>}</Key>
          </>
        }>{(pairing) => <>
          <PairingCode code={pairing().code} expiresAt={pairing().expiresAt} />
          <Show when={allowed("remote.pair.cancel")}><button class="secondary" aria-busy={working("remote.pair.cancel") || undefined} onClick={() => { void mutate({ type: "remote.pair.cancel" }) }}>Cancel pairing</button></Show>
        </>}</Show>}
      </Show>
    </Sheet>
  )
}

function PairingCode(props: { readonly code: string; readonly expiresAt: number }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))
  const code = createMemo(() => {
    const modules = QRCode.create(props.code, { errorCorrectionLevel: "L" }).modules
    let path = ""
    for (let y = 0; y < modules.size; y += 1) for (let x = 0; x < modules.size; x += 1) if (modules.data[y * modules.size + x]) path += `M${x + 4} ${y + 4}h1v1h-1z`
    return { size: modules.size + 8, path }
  })
  return <div class="remote-pairing">
    <svg class="remote-qr" viewBox={`0 0 ${code().size} ${code().size}`} role="img" aria-label="Scan to pair a device"><path d={code().path} /></svg>
    <a class="remote-pairing-link" href={props.code} target="_blank" rel="noreferrer">{props.code}</a>
    <p>Expires in {Math.max(0, Math.ceil((props.expiresAt - now()) / 1_000))} seconds.</p>
  </div>
}
