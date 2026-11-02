import { describe, expect, test } from "bun:test"

import {
  GUARDIAN_MAX_FRAME_BYTES,
  createGuardianFrameReader,
  decodeGuardianReply,
  decodeGuardianRequest,
  destroyGuardianToken,
  encodeGuardianFrame,
  guardianTokenMatches,
  newGuardianToken,
  type GuardianReply,
} from "../../../src/infra/process-guardian-protocol.js"
import { CAPABILITY, GENERATION, adopt, capabilityOf, tokenOf } from "./_guardian-frames.js"

const encoder = new TextEncoder()

describe("guardian frame reader", () => {
  test("refuses a peer that cannot frame within the bound", () => {
    const reader = createGuardianFrameReader()

    expect(() => reader.push(encoder.encode("x".repeat(GUARDIAN_MAX_FRAME_BYTES + 1)))).toThrow(/frame/i)
  })

  test("bounds a frame by the bytes the peer sent, not by its code units", () => {
    // Two bytes per character: half the bound in characters is exactly the
    // bound in bytes, and one character more passes it.
    const withinBound = "\u00e9".repeat(GUARDIAN_MAX_FRAME_BYTES / 2)
    const pastBound = "\u00e9".repeat(GUARDIAN_MAX_FRAME_BYTES / 2 + 1)

    expect(createGuardianFrameReader().push(encoder.encode(withinBound))).toEqual([])
    expect(() => createGuardianFrameReader().push(encoder.encode(pastBound))).toThrow(/bound/i)
  })

  test("carries a multibyte frame through unchanged, however the chunks split it", () => {
    const reader = createGuardianFrameReader()
    const frame = '{"v":1,"kind":"release","token":"caf\u00e9-\u6f22"}'
    const bytes = encoder.encode(`${frame}\n`)
    // Inside the two bytes of the accented character, so a chunk boundary that
    // falls mid-character must not decode as anything yet.
    const cut = encoder.encode('{"v":1,"kind":"release","token":"caf\u00e9').length - 1

    expect(reader.push(bytes.subarray(0, cut))).toEqual([])
    expect(reader.push(bytes.subarray(cut))).toEqual([frame])
  })

  test("refuses bytes that are not valid UTF-8 instead of repairing them", () => {
    const reader = createGuardianFrameReader()

    expect(() => reader.push(new Uint8Array([0x7b, 0xff, 0x0a]))).toThrow(/UTF-8/)
  })

  test("refuses an oversized prefix even when a legal frame follows it", () => {
    const reader = createGuardianFrameReader()
    const oversized = "x".repeat(GUARDIAN_MAX_FRAME_BYTES + 1)

    expect(() => reader.push(encoder.encode(`${oversized}\n{"v":1,"kind":"ready","pid":9}\n`))).toThrow(/bound/i)
  })

  test("keeps an unterminated suffix pending until its terminator arrives", () => {
    const reader = createGuardianFrameReader()

    expect(reader.push(encoder.encode('{"v":1,"kind":"ready","pid":9}\n{"v":1,"kind":'))).toEqual(['{"v":1,"kind":"ready","pid":9}'])
    expect(reader.push(encoder.encode('"released","token":"a"}\n'))).toEqual(['{"v":1,"kind":"released","token":"a"}'])
  })
})

describe("guardian frame codec", () => {
  test("round-trips every request and reply frame", () => {
    const decoded = decodeGuardianRequest(encodeGuardianFrame(adopt(7, "owned:1", 321)).trim())

    expect(decoded).toMatchObject({ v: 1, kind: "adopt", id: 7, generation: GENERATION, token: "owned:1", pid: 321, stopHold: null })
    const held = adopt(8, "owned:2", 322, GENERATION, CAPABILITY, { path: "/config/.oauth_refresh.lock", boundMs: 35_000 })
    expect(decodeGuardianRequest(encodeGuardianFrame(held).trim())).toMatchObject({ kind: "adopt", stopHold: { path: "/config/.oauth_refresh.lock", boundMs: 35_000 } })
    expect(decoded && "capability" in decoded ? tokenOf(decoded.capability) : undefined).toBe(tokenOf(CAPABILITY))
    for (const reply of [
      { v: 1, kind: "ready", id: 1, pid: 42 },
      { v: 1, kind: "opened", id: 2, generation: GENERATION },
      { v: 1, kind: "closed", id: 3, generation: GENERATION, remaining: 0 },
      { v: 1, kind: "rejected", id: 4, reason: "unauthorized" },
      { v: 1, kind: "rejected", id: 5, reason: "container-unproven" },
    ] satisfies GuardianReply[]) {
      expect(decodeGuardianReply(encodeGuardianFrame(reply).trim())).toEqual(reply)
    }
  })

  test("keeps the capability out of everything but the control pipe", () => {
    const frame = adopt(1, "owned:1", 321)
    const secret = tokenOf(CAPABILITY)

    // Whatever holds a frame - a log line, an error, a snapshot - holds the
    // wrapper, and the wrapper does not print the secret. Only the encoder,
    // whose output is the private pipe, unwraps it.
    expect(JSON.stringify(frame)).not.toContain(secret)
    expect(String(frame.capability)).not.toContain(secret)
    expect(encodeGuardianFrame(frame)).toContain(secret)
  })

  test("generates a capability nothing but the pipe can read", () => {
    const capability = newGuardianToken()
    const wire: unknown = JSON.parse(encodeGuardianFrame({ v: 1, kind: "hello", id: 1, capability }))
    const token = typeof wire === "object" && wire !== null && "capability" in wire ? String(wire.capability) : ""

    expect(token).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(String(capability)).not.toContain(token)
    expect(JSON.stringify({ capability })).not.toContain(token)
  })

  test("erases a capability, so what it guarded can never be offered or read again", () => {
    const capability = newGuardianToken()
    const offered = capabilityOf(tokenOf(capability))
    expect(guardianTokenMatches(capability, offered)).toBe(true)

    destroyGuardianToken(capability)

    expect(guardianTokenMatches(capability, offered)).toBe(false)
    expect(guardianTokenMatches(offered, capability)).toBe(false)
    expect(() => encodeGuardianFrame({ v: 1, kind: "hello", id: 2, capability })).toThrow()
    // Erasing what is already erased is the same request, not a failure.
    expect(() => { destroyGuardianToken(capability) }).not.toThrow()
  })

  test("rejects frames a trusted peer could not have produced", () => {
    expect(decodeGuardianRequest("not json")).toBeUndefined()
    expect(decodeGuardianRequest('{"v":2,"kind":"release","id":1,"capability":"c","generation":"g","token":"a"}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"unknown","id":1,"capability":"c"}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"release","id":1,"capability":"c","generation":"g","token":"has space"}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"release","id":0,"capability":"c","generation":"g","token":"a"}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":1,"stopHold":null}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":1.5,"stopHold":null}')).toBeUndefined()
    // A hold names an absolute file and stays within the guardian's bound.
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":9,"stopHold":{"path":"relative.lock","boundMs":1}}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":9,"stopHold":{"path":"/a.lock","boundMs":3600000}}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":9,"stopHold":{"path":"/a.lock","boundMs":1,"extra":1}}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"rejected","id":1,"reason":"whatever"}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"closed","id":1,"generation":"g","remaining":-1}')).toBeUndefined()
  })

  test("rejects a frame carrying a key this protocol does not define", () => {
    expect(decodeGuardianRequest('{"v":1,"kind":"release","id":1,"capability":"c","generation":"g","token":"a","extra":1}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"hello","id":1,"capability":"c","generation":"g"}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"ready","id":1,"pid":9,"cwd":"/"}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"adopted","id":1,"token":"a","pid":9}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"rejected","id":1,"reason":"at-capacity","note":"x"}')).toBeUndefined()
  })

  test("rejects a frame missing a key its kind requires", () => {
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a"}')).toBeUndefined()
    expect(decodeGuardianRequest('{"v":1,"kind":"adopt","id":1,"capability":"c","generation":"g","token":"a","pid":9}')).toBeUndefined()
    expect(decodeGuardianReply('{"v":1,"kind":"rejected","id":1}')).toBeUndefined()
  })
})
