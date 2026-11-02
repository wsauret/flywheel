import { SESSION_KEY, sessionOf } from "../src/app/screen-stack.js"

/** The page's address names the session in view: `/session/<id>`, or the
 *  root when nothing in particular is. A bookmark, a link from another
 *  program, and the browser's back button all reach a session through it. */

const SESSION_PREFIX = "/session/"

export function sessionFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(SESSION_PREFIX)) return undefined
  const rest = pathname.slice(SESSION_PREFIX.length)
  if (rest.length === 0 || rest.includes("/")) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return undefined
  }
}

export function pathForSession(sessionId: string | undefined): string {
  return sessionId === undefined ? "/" : `${SESSION_PREFIX}${encodeURIComponent(sessionId)}`
}

export interface AddressPage {
  readonly history: Pick<History, "state" | "pushState" | "replaceState">
  readonly location: Pick<Location, "pathname">
}

/** Keeps the page's address on the selected session, with one history entry
 *  per change of selection. The client writes its own entries for a level
 *  inside a chat, such as a workflow's agent view, and names in each the
 *  session it shows; a selection that such an entry already names takes the
 *  address into that entry instead of pushing another over it, so Back
 *  leaves the level in one step. */
export function createAddressFollower(page: AddressPage) {
  let addressed = false
  return {
    follow(sessionId: string | undefined): void {
      const path = pathForSession(sessionId)
      const state: unknown = page.history.state
      if (page.location.pathname !== path) {
        const named = sessionId !== undefined && sessionOf(state) === sessionId
        const shown = sessionId === undefined ? {} : { [SESSION_KEY]: sessionId }
        if (!addressed || named) page.history.replaceState({ ...(state instanceof Object ? state : {}), ...shown }, "", path)
        else page.history.pushState(shown, "", path)
      }
      addressed = true
    },
    /** The session that the entry Back or Forward reached shows. */
    popped(): string | undefined {
      return sessionOf(page.history.state) ?? sessionFromPath(page.location.pathname)
    },
  }
}
