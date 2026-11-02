import { describe, expect, test } from "bun:test"
import { openSheetCommand } from "../../../../src/protocol/client/host-contract.js"

describe("openSheetCommand", () => {
  test("preserves an exact paid-use review for the provider sheet", () => {
    expect(openSheetCommand("providers", {
      kind: "review-paid-use",
      providerId: "chatgpt",
      accountCorrelationId: "account",
      envelopeId: "paid",
    })).toEqual({
      type: "openSheet",
      sheet: "providers",
      focus: {
        kind: "review-paid-use",
        providerId: "chatgpt",
        accountCorrelationId: "account",
        envelopeId: "paid",
      },
    })
  })
})
