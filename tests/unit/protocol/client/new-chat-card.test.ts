import { describe, expect, test } from "bun:test"

import { cardProfileName } from "../../../../src/protocol/client/new-chat-card.js"

describe("a new chat's card", () => {
  test("names the profile only when more than one exists", () => {
    expect(cardProfileName({ displayName: "Personal", count: 1 })).toBeUndefined()
    expect(cardProfileName({ displayName: "Personal", count: 2 })).toBe("Personal")
    expect(cardProfileName(undefined)).toBeUndefined()
  })
})
