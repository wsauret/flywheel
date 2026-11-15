import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { createTranscriptWindowProjector } from "../../../../src/tui/output-window/output-window-projection.js"
import { turnFoldProjector } from "../../../../src/tui/output-window/turn-fold-projection.js"
import { snapshot } from "../_output-window-transcript.js"

const blocks: FrontendOutputBlock[] = [
  { kind: "userMessage", id: "person", content: "Look into it", timestamp: 1000, pending: false, injected: false },
  { kind: "text", id: "narration", content: "Checking my chats.", timestamp: 1500 },
  { kind: "tool", id: "progress", name: "chat_progress", action: "ui_meta", presentation: { name: "Chat progress", detail: "" }, status: "completed", timestamp: 2000 },
  { kind: "text", id: "answer", content: "Nothing works on it yet.", timestamp: 5000 },
]

describe("the turn fold projection", () => {
  it("measures an open fold at its first row and every other row it holds once as no height", () => {
    const window = createTranscriptWindowProjector()(snapshot({ blocks }), false)
    const project = turnFoldProjector({ hidden: new Set() }, "open-fold-session")
    const folded = project(window, true, () => true)
    const at = folded.timelineBlocks.findIndex((row) => row.kind === "turnFold")
    const anchor = folded.timelineBlockIndices[at]
    expect(anchor).toBe(1)
    expect(folded.zeroHeightBlockIndices).toEqual([2])
  })
})
