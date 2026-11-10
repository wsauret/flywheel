import { mountClient } from "../src/index.js"
import { mountPerPlacement, type PlacementClient } from "./placement-client.js"
import { createPushCapability } from "./push.js"
import { computeKeyboardInset, isIosInstalledApp, isTap, keyboardMayBeOpen, revealDelta, shouldPinScroll, type ScreenPoint } from "./keyboard-inset.js"
import { scanPairingCode } from "./qr-scan.js"
import { createRelayHost } from "./relay-host.js"
import { restoreSessionAddress, takeSessionAddress } from "./session-address.js"
import type { PhoneBootstrap } from "../../src/protocol/modules/remote/phone-bootstrap.js"
import { decodeCurrentClient } from "../../src/protocol/modules/remote/relay-protocol.js"
import "../local/theme.css"
import "./host-theme.css"

/** The phone shell. It has no UI of its own: it takes the device store the
 *  hosted page hands it, builds the relay host, and mounts the client with a
 *  sealed socket to whichever placement is selected. Everything a person sees
 *  is the client, the same bundle the editor renders.
 *
 *  This file ships with the runtime, not with the hosted page: the page loads
 *  it from the relay under the identity of the client the machine serves. So
 *  the page that mounts it can be older than it, and the page states the host
 *  contract version it was built for and the identity of the bundle it
 *  loaded; the client checks the one at mount and offers the other at every
 *  attach. When the runtime refuses the identity, the client reloads the
 *  document and the page loads the machine's current client in its place.
 *
 *  Two things are the host's because only a browser on a phone has them: the
 *  camera, offered to the client as the `scan` capability, and the soft
 *  keyboard, whose inset is measured from `visualViewport` and handed to the
 *  stylesheet as a custom property so the composer stays above it. */

function hostRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>("#root")
  if (!root) throw new Error("the host page has no #root")
  return root
}

/** The store the hosted page opened and handed over before this script ran. */
function bootstrapStore(): PhoneBootstrap["store"] {
  const bootstrap = window.flywheelPhoneBootstrap
  if (!bootstrap) throw new Error("the page that loaded this Flywheel client did not hand it a device store")
  return bootstrap.store
}

/** How long after the last viewport or focus event the geometry is read once
 *  more. The iOS keyboard animates for about a quarter of a second, and the
 *  last resize event it delivers can carry a mid-animation height. */
const KEYBOARD_SETTLE_MS = 400

function installKeyboardInset(target: HTMLElement): void {
  const viewport = window.visualViewport
  if (!viewport) return
  let shownInset = 0
  let shownActive: Element | null = null
  const apply = () => {
    // The shell's own rendered height, not the layout viewport: in an
    // installed iOS app the stylesheet sizes the shell to the screen while
    // the layout viewport reads shorter by the status bar.
    const measured = computeKeyboardInset({ height: viewport.height }, target.offsetHeight)
    // No editable element focused means no keyboard, whatever the viewport
    // says: a stale measurement must not hold the composer off the bottom.
    const active = document.activeElement
    const inset = active instanceof HTMLElement && keyboardMayBeOpen(active) ? measured : 0
    target.style.setProperty("--fw-keyboard-inset", `${inset}px`)
    // The keyboard covers the home indicator, so the composer's safe-area
    // padding would float it above the keyboard by that height.
    if (inset > 0) target.style.setProperty("--fw-keyboard-safe", "0px")
    else target.style.removeProperty("--fw-keyboard-safe")
    // iOS scrolls the page when a focused input would sit under the keyboard,
    // which drags the header under the status bar. Pin it back.
    if (shouldPinScroll(inset)) window.scrollTo(0, 0)
    // The pinned page cannot reveal the field, so its own scroller does, once
    // per keyboard height and focused field: a person who then scrolls the
    // field away is not pulled back.
    if (inset > 0 && active instanceof HTMLElement && (inset !== shownInset || active !== shownActive)) revealInScroller(active, target, viewport.height)
    shownInset = inset
    shownActive = active
  }
  let settle: ReturnType<typeof setTimeout> | undefined
  const applyAndSettle = () => {
    apply()
    clearTimeout(settle)
    settle = setTimeout(apply, KEYBOARD_SETTLE_MS)
  }
  viewport.addEventListener("resize", applyAndSettle)
  viewport.addEventListener("scroll", applyAndSettle)
  // Focus moves before the keyboard does. `focusout` fires while the old
  // element is still active, so the read waits one task for the new one.
  document.addEventListener("focusin", applyAndSettle)
  document.addEventListener("focusout", () => setTimeout(applyAndSettle, 0))
  apply()
  installFocusWithoutScroll(target)
}

/** iOS scrolls the page to reveal a field the keyboard will cover. The inset
 *  above lifts the shell instead and pins the scroll back, but on the first
 *  keyboard after a while iOS scrolls before the viewport reports the
 *  keyboard, so the whole page visibly slides down and back while the
 *  keyboard rises. A tap on a field therefore focuses it here with
 *  `preventScroll`, and the inset reveals it inside its own scroller. */
function installFocusWithoutScroll(shell: HTMLElement): void {
  let start: ScreenPoint | undefined
  shell.addEventListener("touchstart", (event) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined
    start = touch && { x: touch.clientX, y: touch.clientY }
  }, { passive: true })
  shell.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0]
    const field = event.target instanceof Element ? event.target.closest("textarea, input, [contenteditable]") : null
    if (!start || !touch || event.touches.length > 0 || !(field instanceof HTMLElement) || field === document.activeElement) return
    if (!isTap(start, { x: touch.clientX, y: touch.clientY }) || !keyboardMayBeOpen(field)) return
    // Cancelling the touch cancels the native focus and its scroll.
    event.preventDefault()
    field.focus({ preventScroll: true })
  }, { passive: false })
}

/** Scrolls the nearest scroller around `field` so the field shows above
 *  `keyboardTop`, in page pixels. A field in no scroller sits in the fixed
 *  shell, which the inset already lifts. */
function revealInScroller(field: HTMLElement, shell: HTMLElement, keyboardTop: number): void {
  for (let node = field.parentElement; node && node !== shell; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== "auto" && overflow !== "scroll") continue
    const box = node.getBoundingClientRect()
    const rect = field.getBoundingClientRect()
    node.scrollTop += revealDelta({ top: rect.top, bottom: rect.bottom }, { top: box.top, bottom: Math.min(box.bottom, keyboardTop) })
    return
  }
}

/** Adds the top-edge strip that host-theme.css describes. The client ships
 *  with the runtime and the hosted page does not, so the host owns it. iOS
 *  keeps the status bar colour it sampled from the strip while the same
 *  element holds the edge, so a change of colour scheme puts a new element
 *  in its place, which makes iOS sample the new colour. */
function installStatusEdge(): void {
  const create = () => {
    const edge = document.createElement("div")
    edge.className = "status-edge"
    edge.setAttribute("aria-hidden", "true")
    return edge
  }
  let edge = create()
  document.body.append(edge)
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const fresh = create()
    edge.replaceWith(fresh)
    edge = fresh
  })
}

/** A pairing link opened from the camera app lands here with the code in the
 *  fragment. It is consumed once and cleared, so a reload does not pair twice. */
function pendingPairingCode(): string | undefined {
  const hash = location.hash
  if (!hash.includes("p=")) return undefined
  // The client keeps which screen this entry is in the state; only the
  // fragment goes.
  history.replaceState(history.state, "", location.pathname)
  return hash
}

/** Pairs from the fragment when one is pending, with the machines sheet open
 *  so the exchange and its outcome are in view. A link tapped while this page
 *  is already open arrives as a hash change rather than a load, so both paths
 *  land here. */
async function pairFromFragment(relay: Awaited<ReturnType<typeof createRelayHost>>, client: PlacementClient): Promise<void> {
  const code = pendingPairingCode()
  if (code === undefined) return
  client.handle.command({ type: "openSurface", surface: "runtimes" })
  await relay.capability.pair(code).catch(() => {
    // The client shows the failure from the capability's snapshot.
  })
}

async function main(): Promise<void> {
  const root = hostRoot()
  // The stylesheet sizes the shell differently in an installed iOS app, and
  // no media query tells it so; see isIosInstalledApp.
  document.documentElement.classList.toggle("ios-installed", isIosInstalledApp("standalone" in navigator ? navigator : {}))
  installStatusEdge()
  const store = bootstrapStore()
  const relay = await createRelayHost(store, navigator.mediaDevices ? { scan: scanPairingCode } : {})
  const push = createPushCapability()
  const initialAddress = takeSessionAddress(window)
  if (initialAddress?.selection) relay.capability.select(initialAddress.selection)
  const client = mountPerPlacement(relay, (initialSessionId, initialAttention) => {
    let pendingAddress = initialSessionId === undefined ? undefined : { sessionId: initialSessionId, attention: initialAttention === true, selection: relay.capability.snapshot().selected }
    return mountClient(root, {
      surface: "phone",
      inputScope: () => JSON.stringify(relay.capability.snapshot().selected ?? { unselected: true }),
      socket: relay.socket,
      ...(initialSessionId === undefined ? {} : { initialSessionId }),
      ...(initialAttention ? { initialAttention: true } : {}),
      ...(root.dataset.clientIdentity === undefined ? {} : { clientIdentity: root.dataset.clientIdentity }),
      ...(root.dataset.hostContract === undefined ? {} : { hostContract: Number(root.dataset.hostContract) }),
      capabilities: {
        writeClipboardText: (text) => navigator.clipboard.writeText(text),
        openExternal: async (url) => {
          window.open(url, "_blank", "noopener")
        },
        remote: relay.capability,
        push,
        replacement: {
          async prepare() {
            const frame = relay.capability.snapshot()
            const selected = frame.selected
            const runtime = frame.runtimes.find((candidate) => candidate.runtimeId === selected?.runtimeId)
            if (!runtime) throw new Error("The selected machine is unavailable")
            const origin = new URL(runtime.relay)
            origin.protocol = origin.protocol === "ws:" ? "http:" : "https:"
            const response = await fetch(`${origin.origin}/client/${runtime.runtimeId}/current`, { cache: "no-store" })
            if (!response.ok) throw new Error("The phone client is unavailable")
            const successor = decodeCurrentClient(await response.json())
            await Promise.all(["webview.js", "webview.css"].map(async (file) => {
              const asset = await fetch(`${origin.origin}/client/${runtime.runtimeId}/${successor.identity}/phone/${file}`)
              if (!asset.ok) throw new Error("The phone client is unavailable")
              await asset.arrayBuffer()
            }))
          },
          async commit() {
            if (pendingAddress !== undefined) restoreSessionAddress(window, pendingAddress)
            location.reload()
          },
        },
      },
      onSummary: (summary) => { if (summary.ready) pendingAddress = undefined },
      // oxlint-disable-next-line no-console -- boundary: the browser console is the only diagnostics sink this page has
      onDiagnostic: (message, detail) => console.warn(message, detail),
    })
  }, initialAddress)
  installKeyboardInset(root)
  // A notification tapped while this page is open can arrive as a hash
  // change rather than a load.
  window.addEventListener("hashchange", () => {
    const address = takeSessionAddress(window)
    if (address !== undefined) client.openAddress(address)
    void pairFromFragment(relay, client)
  })
  await pairFromFragment(relay, client)
}

void main()
