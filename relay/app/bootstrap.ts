import { HOST_CONTRACT_VERSION } from "../../src/protocol/client/host-contract.js"
import { readNotificationAddress } from "../../src/protocol/modules/remote/notification-address.js"
import type { PhoneBootstrap } from "../../src/protocol/modules/remote/phone-bootstrap.js"
import { pairDevice } from "../../src/protocol/modules/remote/relay-pairing.js"
import { deviceIdentity, type DeviceStore, type PairedRuntime } from "../../src/protocol/modules/remote/relay-device.js"
import { scanPairingCode } from "../../webview/phone/qr-scan.js"
import { assetOrigin, currentClient, type ClientSource, type KnownRuntime } from "./client-choice.js"
import { openDeviceStore } from "./device-store.js"
import { createPageStart, type PairingRequest } from "./page-start.js"
import "./bootstrap.css"

/** The hosted phone page. It owns what must outlive every client build (the
 *  device key and pairings, and the Web Push service worker beside it), picks
 *  the client build a paired machine serves, and loads that build's phone
 *  shell from the machine's relay. The shell and the client it mounts draw
 *  everything a person sees; this page draws only the one screen nothing
 *  else can: pairing, when no machine is paired, when the page opens with a
 *  pairing link, and when no paired machine could serve a client. The order
 *  of those decisions is `page-start.ts`.
 *
 *  It deploys almost never, so it holds no knowledge of the client beyond the
 *  host contract it states on `#root` and the device store it hands over. */

const CURRENT_POLL_MS = 1_000
const PRIVACY_URL = "https://github.com/wsauret/flywheel/blob/main/docs/privacy.md"

/** `localStorage`, or a store that keeps nothing where the browser refuses it. */
function localStore(): Pick<Storage, "getItem" | "setItem"> {
  try {
    return localStorage
  } catch {
    return { getItem: () => null, setItem: () => {} }
  }
}

function pageRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#root")
  if (!root) throw new Error("the hosted page has no #root")
  return root
}

/** Asks every paired machine's relay which client it serves, again each
 *  second until the relay names one for the preferred machine (or for any
 *  machine, with none preferred) or `waitMs` runs out, and answers the last
 *  word for each. */
async function currentClients(paired: readonly PairedRuntime[], preferred: string | undefined, waitMs: number): Promise<KnownRuntime[]> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const known = await Promise.all(paired.map(async (runtime) => ({
      runtimeId: runtime.runtimeId,
      relay: runtime.relay,
      current: await currentClient(runtime.relay, runtime.runtimeId, (url) => fetch(url, { cache: "no-store", signal: AbortSignal.timeout(CURRENT_POLL_MS * 5) })),
    })))
    const answered = known.some((runtime) => runtime.current !== undefined && (preferred === undefined || runtime.runtimeId === preferred))
    if (answered || Date.now() + CURRENT_POLL_MS > deadline) return known
    await new Promise((resolve) => { setTimeout(resolve, CURRENT_POLL_MS) })
  }
}

/** Loads one client build's phone shell. Resolves once its script ran, and
 *  rejects when the relay could not serve it. */
function loadShell(root: HTMLElement, source: ClientSource): Promise<void> {
  const base = `${assetOrigin(source.relay)}/client/${source.runtimeId}/${source.identity}/phone`
  for (const stale of document.querySelectorAll("[data-flywheel-client]")) stale.remove()
  // The shell renders into `#root`, so the page's own screen leaves first.
  root.replaceChildren()
  root.dataset.clientIdentity = source.identity
  root.dataset.hostContract = String(HOST_CONTRACT_VERSION)
  const style = document.createElement("link")
  style.rel = "stylesheet"
  style.href = `${base}/webview.css`
  style.dataset.flywheelClient = ""
  const script = document.createElement("script")
  script.type = "module"
  script.src = `${base}/webview.js`
  script.dataset.flywheelClient = ""
  const loaded = new Promise<void>((resolve, reject) => {
    script.addEventListener("load", () => resolve(), { once: true })
    script.addEventListener("error", () => reject(new Error(`the relay did not serve ${script.src}`)), { once: true })
  })
  document.head.append(style, script)
  return loaded
}

function screen(root: HTMLElement, build: (main: HTMLElement) => void): void {
  const main = document.createElement("main")
  main.className = "boot"
  build(main)
  root.replaceChildren(main)
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag)
  Object.assign(created, properties)
  created.append(...children)
  return created
}

/** The pairing screen. It shows when no machine is paired, when the page
 *  opens with a pairing link, and when every paired machine is asleep or
 *  offline, which it then says above the steps, with a way to try again. */
function showPairing(root: HTMLElement, store: DeviceStore, request: PairingRequest): void {
  const status = element("p", { className: "status" })
  status.setAttribute("role", "status")
  const controls: (HTMLButtonElement | HTMLInputElement)[] = []
  const pair = async (text: string) => {
    if (text.trim().length === 0) return
    for (const control of controls) control.disabled = true
    status.className = "status"
    status.textContent = "Pairing with the machine..."
    try {
      await request.pair(text.trim(), (label) => { status.textContent = `Paired with ${label}. Opening Flywheel...` })
    } catch (cause) {
      status.className = "status warn"
      status.textContent = cause instanceof Error ? cause.message : String(cause)
      for (const control of controls) control.disabled = false
    }
  }
  const name = element("input", { type: "text", autocomplete: "off", value: store.label() })
  name.setAttribute("enterkeyhint", "done")
  name.addEventListener("change", () => { void store.setLabel(name.value) })
  const link = element("input", { type: "text", autocomplete: "off", placeholder: "or paste the link from the code" })
  link.setAttribute("inputmode", "url")
  link.setAttribute("aria-label", "Pairing link")
  const submit = element("button", { type: "submit" }, "Pair")
  const form = element("form", {}, link, submit)
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    void pair(link.value)
  })
  controls.push(name, link, submit)
  screen(root, (main) => {
    main.append(element("h1", {}, "Pair this phone with a machine"))
    if (request.unreachable !== undefined) {
      const machine = request.unreachable.machine
      main.append(
        element("p", { className: "status warn" }, `${machine === undefined ? "Flywheel could not load from the paired machine" : `Flywheel could not load from ${machine}`}. It is asleep or offline. Wake it and try again, or pair this phone with another machine.`),
        element("button", { type: "button", onclick: () => location.reload() }, "Try again"),
      )
    }
    const lead = element("p", {}, "On the machine, run ", element("code", {}, "flywheel remote pair"), " or type ", element("code", {}, "/remote"), " in Flywheel, then scan the code it shows.")
    main.append(lead, element("label", {}, "This phone's name, as the machine will list it", name))
    if (navigator.mediaDevices) {
      const scan = element("button", { className: "primary", type: "button", onclick: async () => {
        const read = await scanPairingCode()
        if (read !== undefined) await pair(read)
      } }, "Scan a code")
      controls.push(scan)
      main.append(scan)
    }
    main.append(form, status, element("p", { className: "fine" }, element("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, "Privacy")))
  })
  if (request.code !== undefined) void pair(request.code)
}

/** A pairing link opened from the camera app lands here with the code in the
 *  fragment. The page consumes it before anything else, whatever machines
 *  this phone already pairs with. A link tapped while the shell is open
 *  arrives as a hash change, which the shell pairs from itself. */
function takePairingCode(): string | undefined {
  if (!location.hash.includes("p=")) return undefined
  const code = location.hash
  history.replaceState(history.state, "", location.pathname)
  return code
}

async function boot(): Promise<void> {
  const root = pageRoot()
  const store = await openDeviceStore()
  window.flywheelPhoneBootstrap = { store } satisfies PhoneBootstrap
  const page = createPageStart({
    store,
    storage: localStore(),
    takePairingCode,
    notificationAddress: () => readNotificationAddress(location.hash),
    currentClients,
    pairDevice: (code) => pairDevice(code, { publicKey: store.device.publicKey, sign: deviceIdentity(store.device).sign, label: store.label() }),
    loadShell: (source) => loadShell(root, source),
    showPairing: (request) => showPairing(root, store, request),
  })
  await page.start()
}

void boot()
