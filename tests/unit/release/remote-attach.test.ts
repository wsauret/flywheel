import { describe, expect, test } from "bun:test"

import { predatesRemoteTerminal } from "../../release/scenarios/remote-attach.js"

/** The usage text of v0.1.0, whose `flywheel remote` has no `machines` verb. */
const PRE_REMOTE_USAGE = "Usage: flywheel remote <pair|devices|projects|status> [options]\n\nPair a phone with this machine.\n"

describe("the remote-attach baseline probe", () => {
  test("only the usage refusal of a binary without `remote machines` marks the baseline unavailable", () => {
    expect(predatesRemoteTerminal({ exitCode: 2, stdout: "", stderr: PRE_REMOTE_USAGE })).toBe(true)
  })

  test("any other failure of the probe is a baseline failure", () => {
    expect(predatesRemoteTerminal({ exitCode: 2, stdout: "", stderr: "Usage: flywheel remote <pair|devices|projects|status|machines> [options]\n" })).toBe(false)
    expect(predatesRemoteTerminal({ exitCode: 1, stdout: "", stderr: PRE_REMOTE_USAGE })).toBe(false)
    expect(predatesRemoteTerminal({ exitCode: 134, stdout: "", stderr: "panic: segmentation fault\n" })).toBe(false)
    expect(predatesRemoteTerminal({ exitCode: 0, stdout: "No paired machines.\n", stderr: "" })).toBe(false)
  })
})
