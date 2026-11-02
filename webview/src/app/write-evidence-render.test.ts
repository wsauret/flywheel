import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { MutationEvidenceReader, MutationFilesView, MutationPatchView } from "../../../src/protocol/client/mutation-evidence.js"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"
import { rendered } from "./blocks-render-loader-fixture.js"

const { renderBlock, tool } = rendered
const proposedDiff = {
  files: [{
    id: "file-1",
    path: "src/example.ts",
    action: "add" as const,
    hunks: [{
      id: "hunk-1",
      omittedBefore: 0,
      omittedAfter: 0,
      lines: [{ id: "line-1", kind: "add" as const, text: "const answer = 42", partial: true }],
    }],
  }],
}

function assertWritePalette(html: string): void {
  assert.match(html, /class="tool-body write-syntax"/)
  assert.match(html, /class="file-diff"/)
  assert.match(html, /--fw-write-syntax-text:/)
  assert.match(html, /--fw-write-syntax-keyword:/)
}

describe("Write syntax component scope", () => {
  test("scopes proposed and streaming Write output", () => {
    assertWritePalette(renderBlock(tool({ proposedDiff })))
    assertWritePalette(renderBlock(tool(), { streaming: { proposedDiff } }))
  })

  test("scopes settled, reopened, and hydrated Write bodies", async () => {
    const fixture = await mutationEvidenceFixture({
      version: 1,
      files: [{ path: "src/example.ts", change: "added", unifiedDiff: "@@ -0,0 +1 @@\n+const answer = 42" }],
      omissions: [],
    })
    try {
      await fixture.reader.open("write-1", fixture.evidence.manifest, { previews: true }).loadFiles()
      const settled = tool({ status: "completed", mutationEvidence: fixture.evidence })
      assertWritePalette(renderBlock(settled, { mutationEvidence: fixture.reader }))
      assertWritePalette(renderBlock(settled, { reopened: true, mutationEvidence: fixture.reader }))
      assertWritePalette(renderBlock(tool({ status: "completed" }), {
        body: { blockId: "tool:write-1", mutationEvidence: fixture.evidence },
        mutationEvidence: fixture.reader,
      }))
    } finally { fixture.reader.dispose() }
  })

  test("does not scope edits, patches, other tools, or chat fenced code", () => {
    const writeContent = { content: "const answer = 42", filetype: "ts" }
    assert.doesNotMatch(renderBlock(tool({ fileChangeKind: "replace" }), { streaming: writeContent }), /write-syntax/)
    assert.doesNotMatch(renderBlock(tool({ fileChangeKind: "patch" }), { streaming: writeContent }), /write-syntax/)
    assert.doesNotMatch(renderBlock(tool({ name: "bash", fileChangeKind: undefined }), { streaming: writeContent }), /write-syntax/)
    assert.doesNotMatch(renderBlock({
      kind: "text",
      id: "text-1",
      content: "```ts\nconst answer = 42\n```",
      timestamp: 0,
    }), /write-syntax/)
  })

  test("keeps unknown-language Write text visible under the baseline palette", () => {
    const html = renderBlock(tool(), { streaming: { content: "alpha < beta", filetype: "unknown-write-language" } })
    assert.match(html, /class="tool-body write-syntax"/)
    assert.match(html, /class="code"/)
    assert.match(html, /--fw-write-syntax-text:/)
    assert.match(html, /alpha &lt; beta/)
  })
})

test("reference evidence keeps Write palettes, display paths, and actual failure evidence without command output", () => {
  const reference = { version: 1 as const, root: "b".repeat(64), bytes: 40, sha256: "c".repeat(64) }
  const file: Extract<MutationFilesView["files"][number], { kind: "applied" }> = { kind: "applied", file: {
    version: 1, mutationId: "write", path: "/project/src/evidence.ts", displayPath: "src/evidence.ts",
    change: "added", before: null, after: null, retainedLines: 1, renderedLines: 1,
    omittedLines: 0, addedLines: 1, removedLines: 0, conflictMarkers: false,
    patch: { kind: "retained", reference },
  } }
  const evidence: NonNullable<FrontendToolEntry["mutationEvidence"]> = {
    version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 512, entries: 1 },
    applied: 1, retainedFiles: 1, omissions: 0, notApplied: 0, added: 1, modified: 0, removed: 0,
    addedLines: 1, removedLines: 0, conflictMarkers: 0, samples: [{ kind: "applied", path: "src/evidence.ts" }],
  }
  for (const status of ["ready", "unavailable"] as const) {
    // A collapsed file renders its page preview; the runtime serves unreadable stored bytes as an unavailable patch.
    const served: MutationFilesView["files"][number] = status === "ready"
      ? { ...file, preview: "@@ -0,0 +1 @@\n+const answer = '<tag>'" }
      : { kind: "applied", file: { ...file.file, patch: { kind: "unavailable" } } }
    const idle: MutationPatchView = { status: "idle", reference, text: "", nextOffset: 0, complete: false }
    const passiveOnly = () => { throw new Error("Render must not request evidence") }
    const reader: MutationEvidenceReader = {
      hasOwners: true, heldBytes: 0, open: () => ({
        files: { status: "ready", offset: 0, files: [served], nextOffset: null },
        loadFiles: passiveOnly,
        patch: () => ({ view: idle, continue: passiveOnly, release() {} }),
      }),
      openPatch: passiveOnly, release() {}, retainOwners() {}, onChange: () => () => {}, dispose() {},
    }
    const entry: FrontendToolEntry = {
      ...tool({ mutationEvidence: evidence, declaresMutation: true, content: "must stay hidden", diffOmission: { kind: "aggregate", omittedLines: 100 } }),
      status: "error", errorMessage: "final result save failed",
    }
    const html = renderBlock(entry, { mutationEvidence: reader, canOpenFiles: true })
    assertWritePalette(html)
    assert.match(html, /diff-file-action-add/)
    assert.match(html, />src\/evidence\.ts</)
    assert.match(html, /final result save failed/)
    assert.doesNotMatch(html, /must stay hidden|\/project\/src\/evidence\.ts|Load the rest/)
    if (status === "ready") {
      // Browser refs mount diff rows. file-diff.test.ts owns their syntax and escaping checks.
      assert.doesNotMatch(html, /diff-marker|Proposed changes/)
    } else {
      assert.match(html, />Change evidence is unavailable</)
      assert.doesNotMatch(html, /Expand diff|Load more diff/)
    }
    const closed = renderBlock(entry, { mutationEvidence: reader, collapsed: true })
    assert.doesNotMatch(closed, /class="file-diff"|Change evidence is unavailable|hljs-keyword/)
  }
})
