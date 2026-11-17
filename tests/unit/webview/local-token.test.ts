import { describe, expect, test } from "bun:test"

import {
  consumeLocalBrowserToken,
  localSocketUrl,
  reloadOnFreshLink,
  tokenAdmitted,
} from "../../../webview/local/token.js"

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const cleanHistory = { state: null, replaceState: () => {} }

/** Opens `origin` from a link whose fragment carries `token`, which stores it. */
function openLink(origin: string, token: string, storage: MemoryStorage): string {
  return consumeLocalBrowserToken({ origin, pathname: "/", search: "", hash: `#token=${encodeURIComponent(token)}` }, cleanHistory, storage)
}

/** The token a page at `origin` opened with no link connects with: the stored one. */
function storedToken(origin: string, storage: MemoryStorage): string {
  return consumeLocalBrowserToken({ origin, pathname: "/", search: "", hash: "" }, cleanHistory, storage)
}

describe("local browser token", () => {
  test("scopes the stored token to the runtime origin", () => {
    const storage = new MemoryStorage()

    openLink("http://127.0.0.1:4312", " first-token ", storage)
    openLink("http://127.0.0.1:4313", "second-token", storage)

    expect([...storage.values]).toEqual([
      ["flywheel.local.token.v1:http://127.0.0.1:4312", "first-token"],
      ["flywheel.local.token.v1:http://127.0.0.1:4313", "second-token"],
    ])
    expect(storedToken("http://127.0.0.1:4312", storage)).toBe("first-token")
    expect(storedToken("http://127.0.0.1:4313", storage)).toBe("second-token")

    // A stored value is read back trimmed.
    storage.setItem("flywheel.local.token.v1:http://127.0.0.1:4312", " padded ")
    expect(storedToken("http://127.0.0.1:4312", storage)).toBe("padded")
  })

  test("consumes a fragment token before mount and preserves other URL fields", () => {
    const storage = new MemoryStorage()
    const replacements: string[] = []
    const token = consumeLocalBrowserToken(
      {
        origin: "http://127.0.0.1:4312",
        pathname: "/sessions",
        search: "?view=active",
        hash: "#token=secret%20value&panel=detail",
      },
      {
        state: { navigation: 1 },
        replaceState: (_state, _unused, url) => replacements.push(String(url)),
      },
      storage,
    )

    expect(token).toBe("secret value")
    expect(storedToken("http://127.0.0.1:4312", storage)).toBe("secret value")
    expect(replacements).toEqual(["/sessions?view=active#panel=detail"])
  })

  test("reloads the origin token without replacing clean history", () => {
    const storage = new MemoryStorage()
    openLink("https://localhost:4312", "persisted", storage)
    let replacements = 0

    const token = consumeLocalBrowserToken(
      {
        origin: "https://localhost:4312",
        pathname: "/",
        search: "",
        hash: "",
      },
      {
        state: null,
        replaceState: () => {
          replacements += 1
        },
      },
      storage,
    )

    expect(token).toBe("persisted")
    expect(replacements).toBe(0)
  })

  test("removes an empty fragment token and clears the stored token", () => {
    const storage = new MemoryStorage()
    openLink("http://localhost:4312", "old", storage)
    const replacements: string[] = []

    const token = consumeLocalBrowserToken(
      {
        origin: "http://localhost:4312",
        pathname: "/",
        search: "",
        hash: "#token=%20",
      },
      {
        state: null,
        replaceState: (_state, _unused, url) => replacements.push(String(url)),
      },
      storage,
    )

    expect(token).toBe("")
    expect(storedToken("http://localhost:4312", storage)).toBe("")
    expect(storage.values.size).toBe(0)
    expect(replacements).toEqual(["/"])
  })

  test("the local WebSocket URL carries no token", () => {
    expect(localSocketUrl("127.0.0.1:4312")).toBe("ws://127.0.0.1:4312/socket")
  })

  test("asks the socket's door whether the stored token still opens the runtime", async () => {
    const asked: Array<{ input: string; init: RequestInit }> = []
    const answering = (status: number) => async (input: string, init: RequestInit) => {
      asked.push({ input, init })
      return new Response(null, { status })
    }

    expect(await tokenAdmitted("secret", answering(204))).toBe("admitted")
    expect(await tokenAdmitted("secret", answering(403))).toBe("refused")
    // A runtime that is not there, or answers with something else, is not a
    // refusal: the same token may open it again once it is back.
    expect(await tokenAdmitted("secret", answering(503))).toBe("unreachable")
    expect(await tokenAdmitted("secret", async () => { throw new Error("connection refused") })).toBe("unreachable")
    expect(asked.map(({ input }) => input)).toEqual(["/socket", "/socket", "/socket"])
    expect(asked.map(({ init }) => init.method)).toEqual(["POST", "POST", "POST"])
    expect(asked.every(({ init }) => new Headers(init.headers).get("Authorization") === "Bearer secret")).toBe(true)
  })

  test("a fresh link opened in the same tab loads the page again, and another fragment change does not", () => {
    const page = new EventTarget()
    const location = { hash: "" }
    let reloads = 0
    reloadOnFreshLink(page, location, () => { reloads += 1 })
    location.hash = "#view=1"
    page.dispatchEvent(new Event("hashchange"))
    expect(reloads).toBe(0)
    location.hash = "#token=fresh"
    page.dispatchEvent(new Event("hashchange"))
    expect(reloads).toBe(1)
  })
})
