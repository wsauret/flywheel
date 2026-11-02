/** Bindings `worker/wrangler.jsonc` declares. */
interface Env {
  readonly RELAY_RUNTIME: DurableObjectNamespace<import("./relay-runtime.js").RelayRuntime>
  readonly REPORTS: DurableObjectNamespace<import("./report-inbox.js").ReportInbox>
  readonly REPORTS_RATE_LIMITER: RateLimit
  /** New runtime, device, and channel sockets per client IP. */
  readonly RELAY_SOCKET_RATE_LIMITER: RateLimit
  /** The operator's levers (`operator-limits.ts`): a Worker variable, and a
   *  secret so that a deploy never resets it. */
  readonly RELAY_DAILY_GIB?: string
  readonly RELAY_ADMISSION?: string
  /** Wrangler secret. Not configured until the reports repository is ready. */
  readonly GITHUB_REPORTS_TOKEN?: string
}
