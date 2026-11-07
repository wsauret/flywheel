import { errorMessage } from "./error-message.js"
import { KERNEL_API_SERVICE } from "./process-diagnostic-reader.js"

/** Opens one kernel process API on its first use, such as libproc on macOS or
 *  kernel32 and ntdll on Windows, and answers the same API on every later
 *  call. An API that cannot be opened answers nothing on every call: a caller
 *  that could not ask has proven nothing, and every later open would fail the
 *  same way, so the failure is remembered rather than retried once per probe.
 *  That failure is recorded once, with `api` and the error, because every
 *  process probe that rests on the API answers unproven from then on. */
export function openKernelApiOnce<Api>(api: string, open: () => Api): () => Api | undefined {
  let opened: Api | undefined
  let failed = false
  return () => {
    if (failed) return undefined
    if (opened !== undefined) return opened
    try {
      opened = open()
      return opened
    } catch (error) {
      failed = true
      recordUnopened(api, error)
      return undefined
    }
  }
}

/** The process modules sit inside the log's own import chain, through the
 *  private directory setup that reads process identities, so the log is
 *  loaded only when there is something to record. */
function recordUnopened(api: string, error: unknown): void {
  void import("./log.js")
    .then(({ Log }) => { Log.create({ service: KERNEL_API_SERVICE }).warn("a kernel process API could not be opened; its process probes answer unproven", { api, error: errorMessage(error) }) })
    .catch(() => {})
}
