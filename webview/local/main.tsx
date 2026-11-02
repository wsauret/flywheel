import { Layer } from "effect"
import { Socket } from "effect/unstable/socket"

import { mountClient } from "../src/index.js"
import type { RuntimeHealth } from "../../src/protocol/app-service-types.js"
import { showGate } from "./gate.js"
import { createAddressFollower, sessionFromPath } from "./route.js"
import { applyTabIdentity, releaseWhileCached } from "./tab.js"
import { consumeLocalBrowserToken, localSocketUrl, reloadOnFreshLink, tokenAdmitted } from "./token.js"
import "./theme.css"

/** The local browser host mounts the shared client against the loopback runtime. */
const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("local browser page has no #root")
const inputScope = root.dataset.inputScope

reloadOnFreshLink(window, location, () => { location.reload() })
const storedToken = consumeLocalBrowserToken(location, history)
if (storedToken) {
  mountLocalClient(root, storedToken)
} else {
  showGate(root, "missing")
}

const PROBE_FIRST_MS = 1_000
const PROBE_MAX_MS = 10_000

function mountLocalClient(host: HTMLElement, token: string): void {
  let health: RuntimeHealth = { kind: "healthy" }
  let probing = false
  // The session owner resolves the opening address through detail. After that,
  // the address follows its selection, with one history entry per change.
  const initialSessionId = sessionFromPath(location.pathname)
  const address = createAddressFollower({ history, location })
  window.addEventListener("popstate", () => {
    const sessionId = address.popped()
    if (sessionId !== undefined) handle.command({ type: "selectSession", sessionId })
  })
  // A connection that drops is usually a runtime restarting, and the same
  // token opens it again when it is back; the client reattaches on its own
  // and nothing here moves. Only a definite refusal means this page's token
  // is no longer the project's, and then the client has nothing to reattach
  // to: the gate takes its place. The runtime may be away when the fault is
  // first seen and back with another token later, so the page keeps asking,
  // slower each time, for as long as the runtime stays lost.
  const probe = async (delay: number): Promise<void> => {
    if (health.kind !== "faulted") {
      probing = false
      return
    }
    if (await tokenAdmitted(token) === "refused") {
      handle.dispose()
      showGate(host, "refused")
      return
    }
    setTimeout(() => { void probe(Math.min(delay * 2, PROBE_MAX_MS)) }, delay)
  }
  const handle = mountClient(host, {
    surface: "web",
    inputScope,
    ...(initialSessionId === undefined ? {} : { initialSessionId }),
    // The runtime admits the upgrade only when the subprotocol is its token and
    // echoes it back, so an empty token fails the handshake at the runtime.
    socket: Socket.layerWebSocket(localSocketUrl(location.host), { protocols: token }).pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
    ),
    // The page states the identity of the bundle it loaded and the host
    // contract it was written for; the client offers the identity at every
    // attach and reloads the document when the runtime refuses it.
    ...(host.dataset.clientIdentity === undefined ? {} : { clientIdentity: host.dataset.clientIdentity }),
    ...(host.dataset.hostContract === undefined ? {} : { hostContract: Number(host.dataset.hostContract) }),
    capabilities: {
      keyboardShortcuts: true,
      writeClipboardText: (text) => navigator.clipboard.writeText(text),
      openExternal: async (url) => {
        window.open(url, "_blank", "noopener")
      },
    },
    onSummary: (summary) => {
      applyTabIdentity(document, summary)
      if (summary.ready) address.follow(summary.sessionId)
      health = summary.health
      if (health.kind === "faulted" && !probing) {
        probing = true
        void probe(PROBE_FIRST_MS)
      }
    },
    // oxlint-disable-next-line no-console -- boundary: the browser console is the only diagnostics sink this page has
    onDiagnostic: (message, detail) => console.warn(message, detail),
  })
  releaseWhileCached(window, () => { handle.dispose() }, () => { location.reload() })
}
