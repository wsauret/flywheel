import { expect, test } from "bun:test"
import { cardPressMoved } from "./card-press.js"

test("a header hold yields to movement beyond 10px", () => {
  const start = { x: 30, y: 20 }
  expect(cardPressMoved(start, { x: 36, y: 28 })).toBe(false)
  expect(cardPressMoved(start, { x: 36, y: 29 })).toBe(true)
})
