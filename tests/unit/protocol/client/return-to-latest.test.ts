import { describe, expect, it } from "bun:test"
import { returnToLatestLabel, unseenMessageCount } from "../../../../src/protocol/client/return-to-latest.js"

describe("return to latest", () => {
  it("labels zero, singular, and plural unseen messages", () => {
    expect(returnToLatestLabel(0)).toBe("Latest")
    expect(returnToLatestLabel(1)).toBe("1 new message")
    expect(returnToLatestLabel(2)).toBe("2 new messages")
  })

  it("rebases unseen messages when authority falls below the baseline", () => {
    expect(unseenMessageCount(8, 5)).toEqual({ baseline: 5, unseen: 0 })
    expect(unseenMessageCount(5, 8)).toEqual({ baseline: 5, unseen: 3 })
  })
})
