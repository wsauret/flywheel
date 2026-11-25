import { randomBytes, timingSafeEqual } from "node:crypto"

const HUB_COOKIE = "flywheel_hub"

/** Whether a browser page may open the runtime's WebSocket: only a page the
 *  runtime itself served, which is the one origin `served` names. A loopback
 *  page on any other port is another program on this machine, and it has no
 *  more claim on this runtime than a page from another site; the token is the
 *  second lock, this is the first. `Origin` is a browser-set header, so a
 *  non-browser client on the loopback is refused here and admitted nowhere. */
export function isServedOrigin(originHeader: string | null, served: string): boolean {
  const trimmed = originHeader?.trim() ?? ""
  if (!trimmed || trimmed === "null") return false
  try {
    return new URL(trimmed).origin === new URL(served).origin
  } catch {
    return false
  }
}

/** Creates the process-local browser credential used only by the fixed hub. */
export function createHubMutationCredential(): string {
  return randomBytes(24).toString("hex")
}

/** Admits a hub mutation only when both browser-controlled origin and the
 * process-local host cookie match. Both comparisons preserve the port. */
export function authorizeHubMutation(headers: Headers, servedOrigin: string, expectedCredential: string): boolean {
  if (!isServedOrigin(headers.get("Origin"), servedOrigin)) return false
  const cookie = headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${HUB_COOKIE}=`))
  const provided = cookie?.slice(HUB_COOKIE.length + 1) ?? ""
  const actual = Buffer.from(provided)
  const expected = Buffer.from(expectedCredential)
  const length = Math.max(actual.length, expected.length)
  const paddedActual = Buffer.alloc(length)
  const paddedExpected = Buffer.alloc(length)
  actual.copy(paddedActual)
  expected.copy(paddedExpected)
  return timingSafeEqual(paddedActual, paddedExpected) && actual.length === expected.length
}
