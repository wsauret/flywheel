import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { rowReveal, rowSettlesOpen, rowSwipeOwns } from "./row-swipe.js"

describe("row reveal", () => {
  test("a leftward drag on a closed row reveals by the distance moved", () => {
    assert.equal(rowReveal(-40, 0, 120), 40)
  })
  test("a rightward drag on a closed row reveals nothing", () => {
    assert.equal(rowReveal(30, 0, 120), 0)
  })
  test("a rightward drag on an open row closes it by the distance moved", () => {
    assert.equal(rowReveal(50, 120, 120), 70)
    assert.equal(rowReveal(200, 120, 120), 0)
  })
  test("travel past the tray resists rather than stopping", () => {
    const past = rowReveal(-220, 0, 120)
    assert.ok(past > 120)
    assert.ok(past < 220)
  })
})

describe("row swipe ownership", () => {
  test("leftward moves are the row's", () => {
    assert.equal(rowSwipeOwns(-12, 0), true)
  })
  test("a rightward move is the row's only while it is open", () => {
    assert.equal(rowSwipeOwns(12, 0), false)
    assert.equal(rowSwipeOwns(12, 120), true)
  })
})

describe("row settling", () => {
  test("a slow drag settles by where it stopped", () => {
    assert.equal(rowSettlesOpen(70, 120, 0), true)
    assert.equal(rowSettlesOpen(50, 120, 0), false)
  })
  test("a quick flick settles the way it went", () => {
    assert.equal(rowSettlesOpen(20, 120, 0.8), true)
    assert.equal(rowSettlesOpen(110, 120, -0.8), false)
  })
})
