import { describe, expect, test } from "bun:test"

import { clampRailWidth, RAIL_WIDTH_MAX_PX, RAIL_WIDTH_MIN_PX, readRailLayout, writeRailLayout } from "../../../webview/src/app/rail-layout.js"

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

describe("session rail layout", () => {
  test("keeps a chosen width inside the rail's span", () => {
    expect(clampRailWidth(10)).toBe(RAIL_WIDTH_MIN_PX)
    expect(clampRailWidth(10_000)).toBe(RAIL_WIDTH_MAX_PX)
    expect(clampRailWidth(300.6)).toBe(301)
  })

  test("round-trips the layout through storage and reads defaults from an empty or broken store", () => {
    const storage = new MemoryStorage()
    expect(readRailLayout(storage)).toEqual({ width: undefined, collapsed: false })

    writeRailLayout(storage, { width: 320, collapsed: true })
    expect(readRailLayout(storage)).toEqual({ width: 320, collapsed: true })

    writeRailLayout(storage, { width: undefined, collapsed: false })
    expect(storage.values.size).toBe(0)

    storage.setItem("flywheel.rail.width", "not a number")
    expect(readRailLayout(storage).width).toBeUndefined()
    storage.setItem("flywheel.rail.width", "5")
    expect(readRailLayout(storage).width).toBe(RAIL_WIDTH_MIN_PX)

    const denied = { getItem() { throw new Error("denied") }, setItem() { throw new Error("denied") }, removeItem() { throw new Error("denied") } }
    expect(readRailLayout(denied)).toEqual({ width: undefined, collapsed: false })
    expect(() => writeRailLayout(denied, { width: 200, collapsed: false })).not.toThrow()
  })
})
