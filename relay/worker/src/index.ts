import { RELAY_PROTOCOL_VERSION } from "../../../src/protocol/modules/remote/relay-protocol.js"
import { receiveReport } from "./reports.js"

/** @externalHost Cloudflare binds the Durable Object class by this exported name. */
export { RelayRuntime } from "./relay-runtime.js"
/** @externalHost Cloudflare binds the report inbox by this exported name. */
export { ReportInbox } from "./report-inbox.js"

/** The relay's front door. Every WebSocket for a runtime id goes to that id's
 *  Durable Object, which is where presence, admission, and pumping live, and
 *  so does every request for the web client that runtime serves
 *  (`/client/<runtimeId>/...`). Each new socket counts against its client
 *  IP's rate limit first, so one address cannot mint runtime identities and
 *  sockets without bound; a client file has its own limits in the object.
 *  POST /reports validates bug reports, applies the client-IP rate limit,
 *  and sends them to the one global report inbox.
 *
 *  `GET /health` answers the release gate's probe with the contract version,
 *  so a deploy that changed the relay's contract is caught before the binary
 *  that expects the old one is published. */
/** @externalHost Cloudflare calls the Worker's default export. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return Response.json({ ok: true, relayProtocolVersion: RELAY_PROTOCOL_VERSION })
    }
    if (url.pathname === "/reports") {
      return receiveReport(request, {
        limiter: env.REPORTS_RATE_LIMITER,
        submit: (report) => env.REPORTS.getByName("global").submit(report),
      })
    }
    const [, role, runtimeId] = url.pathname.split("/")
    if (role === "runtime" || role === "device" || role === "channel") {
      const { success } = await env.RELAY_SOCKET_RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })
      if (!success) return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } })
    }
    if ((role === "runtime" || role === "device" || role === "channel" || role === "client") && runtimeId !== undefined && /^[A-Za-z0-9_-]{43}$/.test(runtimeId)) {
      return env.RELAY_RUNTIME.get(env.RELAY_RUNTIME.idFromName(runtimeId)).fetch(request)
    }
    return new Response("Flywheel relay. Nothing to see here: this hostname carries sealed frames between paired devices and their runtimes.", { status: 404 })
  },
} satisfies ExportedHandler<Env>
