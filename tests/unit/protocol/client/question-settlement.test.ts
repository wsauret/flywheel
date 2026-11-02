import { describe, expect, it } from "bun:test"

import { questionSkip } from "../../../../src/protocol/client/question-settlement.js"

const yes = { kind: "freeform" as const, text: "yes" }

describe("questionSkip", () => {
  it("keeps the given answers when the skip leaves another question", () => {
    expect(questionSkip([["First?", yes], ["Second?", undefined]])).toEqual({ kind: "answer", answers: { "First?": yes } })
  })

  it("cancels the call when no answer is given or no question is left", () => {
    expect(questionSkip([["First?", undefined], ["Second?", undefined]])).toEqual({ kind: "cancel" })
    expect(questionSkip([["First?", yes], ["Second?", yes]])).toEqual({ kind: "cancel" })
  })
})
