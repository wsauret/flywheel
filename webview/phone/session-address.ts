import { readNotificationAddress, type NotificationAddress } from "../../src/protocol/modules/remote/notification-address.js"

/** A tapped notification opens the app on `#session=<id>`, the session the
 *  runtime paged the person about. The fragment is read once and cleared,
 *  keeping the entry's state, so a reload opens the page's own place and not
 *  the notification again. Any other fragment, such as a pairing link's, names
 *  no session and stays for its own reader. */
export function takeSessionAddress(page: {
  readonly location: Pick<Location, "hash" | "pathname">
  readonly history: Pick<History, "state" | "replaceState">
}): NotificationAddress | undefined {
  const address = readNotificationAddress(page.location.hash)
  if (!address) return undefined
  page.history.replaceState(page.history.state, "", page.location.pathname)
  return address
}

/** Restores a consumed address before client admission reloads the document,
 *  so bootstrap selects its machine again and the question action is not lost. */
export function restoreSessionAddress(page: {
  readonly location: Pick<Location, "pathname">
  readonly history: Pick<History, "state" | "replaceState">
}, address: NotificationAddress): void {
  const fragment = new URLSearchParams({ session: address.sessionId })
  if (address.selection) {
    fragment.set("runtime", address.selection.runtimeId)
    fragment.set("placement", address.selection.placementId)
  }
  if (address.attention) fragment.set("attention", "question")
  page.history.replaceState(page.history.state, "", `${page.location.pathname}#${fragment}`)
}
