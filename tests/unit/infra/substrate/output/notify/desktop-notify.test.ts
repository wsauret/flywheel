import { afterEach, beforeEach, describe, it, expect, spyOn } from "bun:test"
import { notifyDesktop } from "../../../../../../src/infra/substrate/output/notify/desktop-notify.js"

const tmux = process.env.TMUX
const sty = process.env.STY
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")

beforeEach(() => {
  delete process.env.TMUX
  delete process.env.STY
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
})

afterEach(() => {
  if (tmux === undefined) delete process.env.TMUX
  else process.env.TMUX = tmux
  if (sty === undefined) delete process.env.STY
  else process.env.STY = sty
  if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
  else Reflect.deleteProperty(process.stdout, "isTTY")
})

/** The bytes one desktop notice writes to standard output. */
function written(title: string, body: string): string {
  const write = spyOn(process.stdout, "write").mockImplementation(() => true)
  try {
    expect(notifyDesktop(title, body)).toEqual({ kind: "accepted" })
    expect(write).toHaveBeenCalledTimes(1)
    return String(write.mock.calls[0]?.[0])
  } finally {
    write.mockRestore()
  }
}

describe("notifyDesktop", () => {
  it("A desktop notice writes one OSC 777 sequence with the title and the body", () => {
    expect(written("Title", "Body")).toBe("\x1b]777;notify;Title;Body\x07")
  })

  it("wraps the escape in the tmux passthrough inside tmux", () => {
    process.env.TMUX = "/scratch/tmux-501/default,1,0"
    expect(written("Title", "Body")).toBe("\x1bPtmux;\x1b\x1b]777;notify;Title;Body\x07\x1b\\")
  })

  it("truncates a body over 200 chars with a trailing ellipsis", () => {
    const seq = written("T", "x".repeat(500))
    const emittedBody = seq.slice("\x1b]777;notify;T;".length, -"\x07".length)
    expect(emittedBody.length).toBe(200)
    expect(emittedBody.endsWith("…")).toBe(true)
  })

  it("collapses runs of whitespace to a single space", () => {
    expect(written("T", "a   b\t\tc\n\nd")).toBe("\x1b]777;notify;T;a b c d\x07")
  })

  it("redacts a recognized credential in the body", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    const seq = written("T", `KEY=${secret}`)
    expect(seq).toContain("[redacted secret]")
    expect(seq).not.toContain(secret)
  })

  it("neutralizes OSC delimiters so the sequence cannot be broken or injected", () => {
    // A body carrying `;`, BEL, and ESC would corrupt the positional escape or
    // inject a second one. After sanitization the field contributes no delimiters:
    // the sequence holds only the three structural `;` (777;notify;title;body) and
    // the single terminating BEL, and the body carries neither `;` nor `\x07`.
    const seq = written("T", "evil;\x07\x1b]0;injected")
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
