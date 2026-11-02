import { describe, expect, it } from "bun:test"

import { createComposerAttachSlot } from "../../../../src/tui/hooks/create-composer-attach-slot.js"

const image = { mediaType: "image/png", data: "aW1n" }

describe("createComposerAttachSlot", () => {
  it("captures the destination sink before asynchronous attachment work starts", () => {
    const slot = createComposerAttachSlot()
    const first: string[] = []
    const second: string[] = []
    slot.register(() => (items) => { first.push(...items.map((item) => item.data)); return { attached: items.length, stopped: null } })

    const append = slot.capture()
    slot.register(() => (items) => { second.push(...items.map((item) => item.data)); return { attached: items.length, stopped: null } })

    expect(append?.([image])).toEqual({ attached: 1, stopped: null })
    expect(first).toEqual(["aW1n"])
    expect(second).toEqual([])
  })
})
