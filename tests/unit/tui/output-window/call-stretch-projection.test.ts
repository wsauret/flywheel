import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { createTranscriptWindowProjector } from "../../../../src/tui/output-window/output-window-projection.js"
import { createCallStretchProjector } from "../../../../src/tui/output-window/call-stretch-projection.js"
import { snapshot } from "../_output-window-transcript.js"

const call = (id: string, name: string, timestamp: number): FrontendOutputBlock => ({ kind: "tool", id, name, action: "ui_meta", presentation: { name, detail: "" }, status: "completed", timestamp })

const blocks: FrontendOutputBlock[] = [
  { kind: "userMessage", id: "person", content: "Look into it", timestamp: 1000, pending: false, injected: false },
  { kind: "text", id: "narration", content: "Checking my chats.", timestamp: 1500 },
  call("progress", "chat_progress", 2000),
  call("checkpoint", "checkpoint_replace", 2100),
  call("route", "route_request", 2200),
  { kind: "text", id: "answer", content: "Nothing works on it yet.", timestamp: 5000 },
]

describe("the call stretch projection", () => {
  it("measures a heading at the first row of its stretch and every other row of the stretch, hidden ones included, once as no height", () => {
    const window = createTranscriptWindowProjector()(snapshot({ blocks }), false)
    const project = createCallStretchProjector({ hidden: new Set(["checkpoint_replace"]) })
    for (const open of [true, false]) {
      const gathered = project(window, false, () => open)
      expect(gathered.timelineBlocks.map((row) => row.kind)).toEqual(["userMessage", "text", "callStretch", "text"])
      expect(gathered.timelineBlockIndices).toEqual([0, 1, 2, 5])
      expect(gathered.zeroHeightBlockIndices).toEqual([3, 4])
    }
  })

  it("starts a heading at its first shown call, never at a bookkeeping call before it", () => {
    const window = createTranscriptWindowProjector()(snapshot({ blocks: [blocks[1]!, call("checkpoint", "checkpoint_replace", 1900), call("progress", "chat_progress", 2000), blocks[5]!] }), false)
    const gathered = createCallStretchProjector({ hidden: new Set(["checkpoint_replace"]) })(window, false, () => undefined)
    expect(gathered.timelineBlocks.find((row) => row.kind === "callStretch")?.timestamp).toBe(2000)
  })
})
