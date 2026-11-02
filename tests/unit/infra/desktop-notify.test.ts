import { describe, it, expect } from "bun:test"
import { buildOsc777 } from "../../../src/infra/desktop-notify.js"

describe("buildOsc777", () => {
  it("emits the exact OSC 777 byte sequence for a plain title/body", () => {
    expect(buildOsc777("Title", "Body", { tmux: false })).toBe("\x1b]777;notify;Title;Body\x07")
  })

  it("wraps the escape in the tmux passthrough when tmux is true", () => {
    expect(buildOsc777("Title", "Body", { tmux: true })).toBe("\x1bPtmux;\x1b\x1b]777;notify;Title;Body\x07\x1b\\")
  })

  it("truncates a body over 200 chars with a trailing ellipsis", () => {
    const body = "x".repeat(500)
    const seq = buildOsc777("T", body, { tmux: false })
    const emittedBody = seq.slice("\x1b]777;notify;T;".length, -"\x07".length)
    expect(emittedBody.length).toBe(200)
    expect(emittedBody.endsWith("…")).toBe(true)
  })

  it("collapses runs of whitespace to a single space", () => {
    expect(buildOsc777("T", "a   b\t\tc\n\nd", { tmux: false })).toBe("\x1b]777;notify;T;a b c d\x07")
  })

  it("redacts a recognized credential in the body", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    const seq = buildOsc777("T", `KEY=${secret}`, { tmux: false })
    expect(seq).toContain("[redacted secret]")
    expect(seq).not.toContain(secret)
  })

  it("neutralizes OSC delimiters so the sequence cannot be broken or injected", () => {
    // A body carrying `;`, BEL, and ESC would corrupt the positional escape or
    // inject a second one. After sanitization the field contributes no delimiters:
    // the sequence holds only the three structural `;` (777;notify;title;body) and
    // the single terminating BEL, and the body carries neither `;` nor `\x07`.
    const seq = buildOsc777("T", "evil;\x07\x1b]0;injected", { tmux: false })
    expect(seq.split(";").length - 1).toBe(3)
    expect(seq.split("\x07").length - 1).toBe(1)
    expect(seq.endsWith("\x07")).toBe(true)
    const body = seq.slice("\x1b]777;notify;T;".length, -"\x07".length)
    expect(body).not.toContain(";")
    expect(body).not.toContain("\x07")
    expect(body).not.toContain("\x1b")
    expect(seq).toBe("\x1b]777;notify;T;evil   ]0 injected\x07")
  })
})
