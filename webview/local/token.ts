const TOKEN_KEY_PREFIX = "flywheel.local.token.v1:"

interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface BrowserTokenLocation {
  origin: string
  pathname: string
  search: string
  hash: string
}

interface BrowserTokenHistory {
  readonly state: unknown
  replaceState(data: unknown, unused: string, url?: string | URL | null): void
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

/** The storage key for one runtime origin. The token belongs to the project
 *  the origin serves, so it is keyed by origin and kept in the browser's
 *  durable storage: a new tab, a bookmark, and a tab left open across a
 *  runtime restart all reach the project again without the link. */
export function tokenKeyForOrigin(origin: string): string {
  return `${TOKEN_KEY_PREFIX}${new URL(origin).origin}`
}

/** The local runtime's WebSocket URL. The token is not part of it: the page
 *  presents the token as the WebSocket subprotocol, which stays out of every
 *  place a URL is recorded. */
export function localSocketUrl(host: string): string {
  return `ws://${host}/socket`
}

/** Reads the stored token for an origin. Storage failures return no token. */
export function loadToken(origin: string, storage: TokenStorage = localStorage): string {
  try {
    const token = storage.getItem(tokenKeyForOrigin(origin))
    return normalizeOptionalString(token) ?? ""
  } catch {
    return ""
  }
}

/** Writes or clears the stored token for an origin. Storage failures are ignored. */
export function persistToken(
  origin: string,
  token: string,
  storage: TokenStorage = localStorage,
): void {
  try {
    const key = tokenKeyForOrigin(origin)
    const normalized = normalizeOptionalString(token) ?? ""
    if (normalized) {
      storage.setItem(key, normalized)
      return
    }
    storage.removeItem(key)
  } catch {
    // Browser storage is best-effort because privacy settings can deny access.
  }
}

/** Consumes a fragment token, removes it from history, and returns the token
 *  this page connects with: the fragment's when the link carried one, else
 *  the stored one, else none. */
export function consumeLocalBrowserToken(
  location: BrowserTokenLocation,
  history: BrowserTokenHistory,
  storage: TokenStorage = localStorage,
): string {
  const hashParams = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  )
  const hasTokenParam = hashParams.has("token")
  const token = normalizeOptionalString(hashParams.get("token")) ?? ""

  if (!hasTokenParam) {
    return loadToken(location.origin, storage)
  }

  persistToken(location.origin, token, storage)
  hashParams.delete("token")
  const nextHash = hashParams.toString()
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${nextHash ? `#${nextHash}` : ""}`,
  )
  return token
}

/** A fresh link opened in a tab that already shows this origin changes only
 *  the address's fragment, and a fragment change loads nothing. The page then
 *  loads again, so the link's token replaces the one the tab holds, whether
 *  the tab shows the client or the gate. */
export function reloadOnFreshLink(page: Pick<EventTarget, "addEventListener">, location: Pick<BrowserTokenLocation, "hash">, reload: () => void): void {
  page.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.replace(/^#/, "")).has("token")) reload()
  })
}

/** Whether the runtime at this page's origin still admits `token`. The page
 *  asks at the socket's door with a plain request, because a browser reports
 *  a refused WebSocket only as a failure, which is also what a runtime that is
 *  not there looks like. Refused is a definite no; anything else, including a
 *  runtime that does not answer, is not. */
export async function tokenAdmitted(
  token: string,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<"admitted" | "refused" | "unreachable"> {
  try {
    // A same-origin GET omits Origin. POST lets the browser supply it for admission.
    const response = await fetcher("/socket", { method: "POST", headers: { Authorization: `Bearer ${token}` } })
    if (response.status === 204) return "admitted"
    if (response.status === 403) return "refused"
    return "unreachable"
  } catch {
    return "unreachable"
  }
}
