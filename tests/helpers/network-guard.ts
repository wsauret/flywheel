import { join, relative, sep } from "node:path"

// Unit tests run offline (AGENTS.md section 5). A request that reaches a remote
// host usually hides behind its owner: a background refresh aborts it within
// milliseconds and swallows the failure, so the test passes and nobody sees
// it. On a loaded host the same download can finish. The guard makes the
// request fail at once and makes the test that started it fail by name.
const repoRoot = join(import.meta.dir, "..", "..")
// Integration tests alone own real I/O, so they keep the network.
const integrationRoot = join(repoRoot, "tests", "integration") + sep
const networkProtocols = new Set(["http:", "https:", "ws:", "wss:"])
const refusedRequests: string[] = []

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/** Records and returns the refusal for a request to a remote host from a unit
 *  test file. A request that stays on this machine, a URL that is not a network
 *  URL, and a request from an integration test return undefined. */
function refusal(kind: string, target: string | URL): TypeError | undefined {
  // The real API reports a malformed URL itself.
  if (!URL.canParse(target)) return undefined
  const url = new URL(target)
  if (!networkProtocols.has(url.protocol) || isLoopback(url.hostname) || Bun.main.startsWith(integrationRoot)) return undefined
  const caller = (new Error().stack ?? "").split("\n").slice(1)
    .filter((frame) => !frame.includes(import.meta.path) && !frame.includes("node_modules"))
    .slice(0, 12)
    .map((frame) => `    ${frame.trim().replaceAll(repoRoot + sep, "")}`)
  refusedRequests.push([`${kind} ${url.href} from ${relative(repoRoot, Bun.main)}`, ...caller].join("\n"))
  return new TypeError(`Unit tests must not reach the network: ${kind} ${url.href}`)
}

/** Replaces the global `fetch` and `WebSocket`, the two ways Flywheel reaches
 *  a remote host, with versions that refuse one. A test that replaces `fetch`
 *  with its own fake bypasses the guard until it restores the original. */
export function installNetworkGuard(): void {
  const realFetch = globalThis.fetch
  const RealWebSocket = globalThis.WebSocket
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: BunFetchRequestInit) => {
      const method = (input instanceof Request ? input.method : init?.method ?? "GET").toUpperCase()
      // A unix socket request never leaves this machine, whatever its URL says.
      const refused = init?.unix === undefined ? refusal(method, input instanceof Request ? input.url : input) : undefined
      return refused ? Promise.reject(refused) : realFetch(input, init)
    },
    {
      preconnect(url: string | URL, options?: Parameters<typeof fetch.preconnect>[1]): void {
        if (!refusal("PRECONNECT", url)) realFetch.preconnect(url, options)
      },
    },
  )
  globalThis.WebSocket = class extends RealWebSocket {
    constructor(...args: ConstructorParameters<typeof RealWebSocket>) {
      const refused = refusal("WEBSOCKET", args[0])
      if (refused) throw refused
      super(...args)
    }
  }
}

/** Fails the running test when the guard refused a request since the last
 *  check. The failure names each request, the test file that was running when
 *  it started, and its caller, then clears the record. */
export function assertNoNetworkRequests(): void {
  if (refusedRequests.length === 0) return
  const report = refusedRequests.splice(0).join("\n\n")
  throw new Error(`A unit test tried to reach the network. Unit tests run offline: inject a fake at the seam the product exposes, or move the test under tests/integration/.\n\n${report}`)
}
