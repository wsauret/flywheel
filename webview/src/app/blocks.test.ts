import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { applyNamedText, resolveQuestionAnswer } from "../client/question-answer.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { createBlockDisclosure } from "./block-disclosure.js"
import { toolFileBodyMode } from "./blocks.js"
import { selectFileChangeBody, type FileChangeBody } from "../../../src/protocol/client/file-change-body.js"

const question = {
  question: "Changes?",
  choices: [
    { kind: "option" as const, choiceId: "api", label: "API", description: "Describe the API", recommended: true, requiresText: true },
    { kind: "option" as const, choiceId: "ui", label: "UI", requiresText: true },
    { kind: "option" as const, choiceId: "keep", label: "Keep" },
    { kind: "freeform" as const, label: "Other" },
  ],
  multiSelect: true,
}

describe("Ask User web answers", () => {
  test("keeps each selected text option and derives canonical display text", () => {
    const api = applyNamedText({ ids: [], text: {} }, "api", "smaller surface", true)
    const both = applyNamedText(api, "ui", "inline editor", true)
    assert.deepEqual(resolveQuestionAnswer(question, both, ""), {
      kind: "choice",
      selections: [
        { choiceId: "api", text: "smaller surface" },
        { choiceId: "ui", text: "inline editor" },
      ],
      text: "API: smaller surface, UI: inline editor",
    })
  })

  test("requires nonblank text and deleting it removes only that selection", () => {
    const selected = applyNamedText({ ids: ["api", "ui"], text: { api: "one", ui: "two" } }, "api", " ", true)
    assert.deepEqual(selected.ids, ["ui"])
    assert.equal(resolveQuestionAnswer(question, { ids: ["api"], text: { api: " " } }, ""), undefined)
  })

  test("Other is canonical when present and named typing is single-select when requested", () => {
    assert.deepEqual(resolveQuestionAnswer(question, { ids: ["keep"], text: {} }, "another route"), { kind: "freeform", text: "another route" })
    assert.deepEqual(applyNamedText({ ids: ["keep"], text: {} }, "api", "change", false).ids, ["api"])
  })
})

function tool(status: "streaming" | "completed", content?: string): FrontendToolEntry {
  return {
    kind: "tool",
    id: "call-1",
    name: "bash",
    presentation: { name: "Bash", detail: "printf output" },
    timestamp: 0,
    status,
    ...(content === undefined ? {} : { content }),
  }
}

describe("web transcript tool rows", () => {
  test("advice and failed file changes expose no body unless actual evidence landed", () => {
    const entry: FrontendToolEntry = {
      kind: "tool",
      id: "write-1",
      name: "write",
      presentation: { name: "Write", detail: "src/example.ts" },
      timestamp: 0,
      status: "streaming",
      fileChangeKind: "create",
      proposedDiff: { files: [] },
      content: "stale raw body",
      diffOmission: { kind: "aggregate", omittedLines: 12 },
    }
    const advisory = selectFileChangeBody(entry, { previewCheck: "Expected a closing brace" })
    assert.deepEqual(toolFileBodyMode(entry, advisory), { bodyAvailable: false, advisory: "Expected a closing brace" })

    const failed: FrontendToolEntry = { ...entry, status: "error", errorMessage: "write failed" }
    assert.deepEqual(toolFileBodyMode(failed, selectFileChangeBody(failed, undefined)), { bodyAvailable: false })
    const settled: FileChangeBody = {
      kind: "actual",
      mutationEvidence: {
        version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 1, entries: 1 },
        applied: 1, retainedFiles: 1, omissions: 0, notApplied: 0, added: 1, modified: 0, removed: 0,
        addedLines: 1, removedLines: 0, conflictMarkers: 0, samples: [{ kind: "applied", path: "src/example.ts" }],
      },
    }
    assert.deepEqual(toolFileBodyMode(failed, settled), { bodyAvailable: true })
  })

  test("a row arrives collapsed whatever its status and opens only for the person", () => {
    // The store is the only writer of row disclosure, and only a tap reaches
    // it: a streaming edit, a proposed diff, and a settled write all read
    // closed until someone opens the row, and stay as the person left them.
    const disclosure = createBlockDisclosure()
    const key = blockIdentity(tool("streaming"))
    assert.equal(disclosure.state("session-1", key)().open, false)
    assert.equal(disclosure.state("session-1", blockIdentity(tool("completed", "written")))().open, false)

    disclosure.setOpen("session-1", key, true)
    assert.equal(disclosure.state("session-1", key)().open, true)
    disclosure.setOpen("session-1", key, false)
    assert.equal(disclosure.state("session-1", key)().open, false)
  })

  test("keeps expansion in the transcript owner across child recreation", () => {
    const disclosure = createBlockDisclosure()
    disclosure.setOpen("session-1", "tool:call-1", true)

    assert.equal(disclosure.state("session-1", "tool:call-1")().open, true)
    assert.equal(disclosure.state("session-2", "tool:call-1")().open, false)
  })
})
