import { describe, expect, test } from "bun:test"

import { clampRailWidth, readRailLayout, writeRailLayout } from "../../../webview/src/app/screens/rail-layout.js"

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

describe("session rail layout", () => {
  test("keeps a chosen width inside the rail's span", () => {
    expect(clampRailWidth(10)).toBe(192)
    expect(clampRailWidth(10_000)).toBe(448)
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
    expect(readRailLayout(storage).width).toBe(192)

    const denied = { getItem() { throw new Error("denied") }, setItem() { throw new Error("denied") }, removeItem() { throw new Error("denied") } }
    expect(readRailLayout(denied)).toEqual({ width: undefined, collapsed: false })
    expect(() => writeRailLayout(denied, { width: 200, collapsed: false })).not.toThrow()
  })
})
