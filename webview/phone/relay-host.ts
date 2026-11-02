import { createRelayClient, type RelayClient } from "../../src/protocol/modules/remote/relay-client.js"
import type { DeviceStore } from "../../src/protocol/modules/remote/relay-device.js"
import type { MachinePickerSnapshot } from "../../src/protocol/modules/remote/machine-picker.js"
import type { RemoteHostCapability, RemoteHostSnapshot } from "../src/host.js"
import { installGuideFor } from "./install-guide.js"

/** The phone host's half of remote access: the `remote` capability the client
 *  renders from, and the `Socket` layer that reaches the selected placement.
 *
 *  Pairing, presence, waking, and the sealed attach are the shared relay
 *  client's (`relay-client.ts`), which every client that reaches a runtime
 *  through the relay uses. The phone adds what only a browser on a phone has:
 *  the camera, offered as `scan`, and the guide to installing the page as an
 *  app, with the browser's install prompt where it has one. */

export interface RelayHost extends Pick<RelayClient, "socket" | "onSelectionChange"> {
  readonly capability: RemoteHostCapability
}

export async function createRelayHost(store: DeviceStore, options: { readonly scan?: () => Promise<string | undefined> } = {}): Promise<RelayHost> {
  const listeners = new Set<(snapshot: RemoteHostSnapshot) => void>()

  // Chromium hands over the install prompt as an event to hold and call later;
  // Safari has no such API and the guide names its taps instead. `appinstalled`
  // ends the guide in the tab that installed, before the display mode changes.
  // Both listen before the relay client loads the store: the prompt fires once
  // per page load, and a page that missed it can only show the menu steps.
  interface InstallPromptEvent extends Event { prompt(): Promise<void>; readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }> }
  let installPrompt: InstallPromptEvent | undefined
  let installed = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true)
  // The relay client's latest snapshot, once it has loaded the store.
  let picker: MachinePickerSnapshot | undefined

  function install(): Pick<RemoteHostSnapshot, "install"> {
    const guide = installGuideFor({ standalone: installed, userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, canPrompt: installPrompt !== undefined })
    return guide === undefined ? {} : { install: guide }
  }
  function emit(current: RemoteHostSnapshot): void {
    for (const listener of listeners) listener(current)
  }
  function publish(): void {
    if (picker) emit({ ...picker, ...install() })
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault()
    installPrompt = event as InstallPromptEvent // oxlint-disable-line typescript/consistent-type-assertions -- boundary: lib.dom does not type the install prompt event
    publish()
  })
  window.addEventListener("appinstalled", () => {
    installed = true
    installPrompt = undefined
    publish()
  })

  const client = await createRelayClient(store)
  picker = client.snapshot()
  client.onChange((next) => {
    picker = next
    publish()
  })

  const capability: RemoteHostCapability = {
    deviceId: client.deviceId,
    snapshot: () => ({ ...client.snapshot(), ...install() }),
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pair: client.pair,
    setLabel: client.setLabel,
    select: client.select,
    forget: client.forget,
    createProject: client.createProject,
    ...(options.scan ? { scan: options.scan } : {}),
    async promptInstall() {
      const prompt = installPrompt
      if (!prompt) return false
      await prompt.prompt()
      const choice = await prompt.userChoice
      // The event is single use whatever the answer.
      installPrompt = undefined
      publish()
      return choice.outcome === "accepted"
    },
  }

  return { capability, socket: client.socket, onSelectionChange: client.onSelectionChange }
}
