import { describe, expect, test } from "bun:test"

import { assetOrigin, chooseClient, currentClient, readLastClient, writeLastClient, type KnownRuntime } from "./client-choice.js"

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)
const RELAY = "wss://relay.flywl.sh"

/** A paired machine and what its relay answered for `/client/<id>/current`:
 *  an identity, or nothing (no answer yet, or none known). */
function runtime(runtimeId: string, current: string | undefined): KnownRuntime {
  return { runtimeId, relay: RELAY, current }
}

describe("which client the hosted page loads", () => {
  test("with no paired machine, or none whose relay names a client and none loaded before, it shows the pairing screen", () => {
    expect(chooseClient({ runtimes: [], preferred: undefined, lastLoaded: { runtimeId: "m", relay: RELAY, identity: A } })).toEqual({ kind: "pair" })
  })

  test("loads the client the relay names for the preferred machine", () => {
    const choice = chooseClient({
      runtimes: [runtime("laptop", A), runtime("desk", B)],
      preferred: "desk",
      lastLoaded: { runtimeId: "desk", relay: RELAY, identity: C },
    })
    expect(choice).toEqual({ kind: "load", runtimeId: "desk", relay: RELAY, identity: B })
  })

  test("while the relay names none for the preferred machine, its last client beats another machine's", () => {
    expect(chooseClient({
      runtimes: [runtime("desk", undefined), runtime("laptop", C)],
      preferred: "desk",
      lastLoaded: { runtimeId: "desk", relay: RELAY, identity: A },
    })).toEqual({ kind: "load", runtimeId: "desk", relay: RELAY, identity: A })
  })

  test("then any paired machine the relay names a client for", () => {
    expect(chooseClient({
      runtimes: [runtime("desk", undefined), runtime("laptop", C)],
      preferred: "desk",
      lastLoaded: undefined,
    })).toEqual({ kind: "load", runtimeId: "laptop", relay: RELAY, identity: C })
  })

  test("then the last client this phone loaded, from a machine it still pairs with", () => {
    expect(chooseClient({
      runtimes: [runtime("desk", undefined), runtime("laptop", undefined)],
      preferred: undefined,
      lastLoaded: { runtimeId: "laptop", relay: RELAY, identity: A },
    })).toEqual({ kind: "load", runtimeId: "laptop", relay: RELAY, identity: A })
  })

  test("never loads a remembered client of a machine this phone no longer pairs with", () => {
    expect(chooseClient({
      runtimes: [runtime("desk", undefined)],
      preferred: undefined,
      lastLoaded: { runtimeId: "forgotten", relay: RELAY, identity: A },
    })).toEqual({ kind: "pair" })
  })
})

describe("asking the relay which client a machine serves", () => {
  function answering(status: number, body: unknown) {
    const asked: string[] = []
    const fetcher = async (url: string) => {
      asked.push(url)
      return Response.json(body, { status })
    }
    return { asked, fetcher }
  }

  test("asks the machine's relay over HTTP and reads the identity it names", async () => {
    const relay = answering(200, { identity: B })
    expect(await currentClient("wss://relay.flywl.sh", "desk", relay.fetcher)).toBe(B)
    expect(relay.asked).toEqual(["https://relay.flywl.sh/client/desk/current"])
  })

  test("reads nothing from a refusal, an answer that is not an identity, or a failed request", async () => {
    expect(await currentClient(RELAY, "desk", answering(503, "no machine").fetcher)).toBeUndefined()
    expect(await currentClient(RELAY, "desk", answering(200, { identity: "not-a-hash" }).fetcher)).toBeUndefined()
    expect(await currentClient(RELAY, "desk", async () => { throw new Error("offline") })).toBeUndefined()
  })
})

describe("the last client this phone loaded", () => {
  function memory(initial?: string) {
    const values = new Map<string, string>(initial === undefined ? [] : [["flywheel.phone.last-client", initial]])
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      values,
    }
  }

  test("round-trips under its version", () => {
    const storage = memory()
    writeLastClient(storage, { runtimeId: "desk", relay: RELAY, identity: A })
    expect(JSON.parse(storage.values.get("flywheel.phone.last-client")!)).toEqual({ v: 1, runtimeId: "desk", relay: RELAY, identity: A })
    expect(readLastClient(storage)).toEqual({ runtimeId: "desk", relay: RELAY, identity: A })
  })

  test("reads nothing from an unknown version, a malformed value, or a storage that throws", () => {
    expect(readLastClient(memory(JSON.stringify({ v: 2, runtimeId: "desk", relay: RELAY, identity: A })))).toBeUndefined()
    expect(readLastClient(memory(JSON.stringify({ v: 1, runtimeId: "desk", relay: RELAY, identity: "not-a-hash" })))).toBeUndefined()
    expect(readLastClient(memory("{"))).toBeUndefined()
    expect(readLastClient({ getItem: () => { throw new Error("blocked") } })).toBeUndefined()
    expect(() => writeLastClient({ setItem: () => { throw new Error("blocked") } }, { runtimeId: "desk", relay: RELAY, identity: A })).not.toThrow()
  })
})

describe("where a relay serves client files", () => {
  test("is the relay's own origin over HTTP", () => {
    expect(assetOrigin("wss://relay.flywl.sh")).toBe("https://relay.flywl.sh")
    expect(assetOrigin("ws://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
    expect(assetOrigin("wss://relay.example.test/")).toBe("https://relay.example.test")
  })
})
