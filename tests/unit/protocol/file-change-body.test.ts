import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ToolStreamingTextSchema, type ProvisionalDiff } from "../../../src/infra/output-blocks.js"
import { conflictMarkersNotice, notAppliedNotice, fileDiffFiles, parseMutationDiffRows, rowPresentation, rowWritePolicy, SHELL_MUTATION_RUNNING, selectFileChangeBody, showsShellMutationOutput } from "../../../src/protocol/client/file-change-body.js"
import { buildMutationEvidence, buildMutationFileEvidence, type MutationEvidence, type MutationFileEvidence } from "../../../src/infra/mutation-evidence.js"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js"
import { OutputProjector } from "../../../src/infra/output/output-projector.js"
import { RuntimeEventProjector } from "../../../src/infra/output/runtime-event-projector.js"
import { createProvisionalDiffInput } from "../../../src/infra/output/provisional-diff-input.js"
import { mutationEvidenceFixture } from "../tui/output-blocks/_mutation-evidence-fixture.js"
import type { MutationDiff } from "../../../src/infra/mutation-diff.js"
import type { FileWritePolicy } from "../../../src/protocol/client/file-change-body.js"

async function diffModels(diff: MutationDiff, expanded: boolean | ((file: { readonly id: string; readonly path?: string }) => boolean), writes: FileWritePolicy = "none") {
  const fixture = await mutationEvidenceFixture(diff)
  try {
    const handle = fixture.reader.open("models", fixture.evidence.manifest, { previews: true })
    await handle.loadFiles()
    return await Promise.all(handle.files.files.filter(entry => entry.kind === "display").map(async entry => {
      const patch = handle.patch(entry)!
      await patch.continue(1000, 1000)
      return fileDiffFiles({ kind: "actual", mutationEvidence: fixture.evidence }, expanded, writes, {
        files: { ...handle.files, files: [entry] }, patch: patch.view,
      })[0]!
    }))
  } finally { fixture.reader.dispose() }
}

const proposal = {
  files: [{
    id: "file:src/a.ts",
    path: "src/a.ts",
    action: "update" as const,
    hunks: [{ id: "hunk:0", lines: [], omittedBefore: 0, omittedAfter: 0 }],
  }],
}

const tool: FrontendToolEntry = {
  kind: "tool",
  id: "tool-1",
  name: "edit",
  fileChangeKind: "patch",
  presentation: { name: "Edit", detail: "src/a.ts" },
  status: "streaming",
  timestamp: 1,
}
const evidence: MutationEvidence = {
  version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 1000, entries: 5000 },
  applied: 5000, retainedFiles: 5000, notApplied: 0, omissions: 0, added: 5000, modified: 0, removed: 0,
  addedLines: 5000, removedLines: 0, conflictMarkers: 0, samples: [{ kind: "applied", path: "new.ts" }],
}

describe("file change body protocol", () => {
  it("keeps settled reference evidence actual before reads and preserves an explicitly proposed handoff", () => {
    const settled = { ...tool, status: "completed" as const, mutationEvidence: evidence, proposedDiff: proposal }
    const body = selectFileChangeBody(settled, undefined)
    expect(body).toEqual({ kind: "actual", mutationEvidence: evidence, pendingProposal: { kind: "proposed", proposedDiff: proposal } })
    expect(fileDiffFiles(body)).toEqual([])
    for (const status of ["error", "interrupted"] as const) {
      const shell = { ...settled, declaresMutation: true as const, status, errorMessage: "timed out" }
      expect(selectFileChangeBody(shell, undefined).kind).toBe("actual")
      expect(showsShellMutationOutput(shell, false)).toBe(false)
      expect(rowPresentation(shell).name).toBe("Write")
      expect(rowPresentation({ ...shell, mutationEvidence: { ...evidence, modified: 1, added: 4999 } }).name).toBe("Edit")
      expect(rowPresentation({ ...shell, mutationEvidence: { ...evidence, applied: 1, retainedFiles: 0, added: 1, omissions: 1 } }).name).toBe("Edit")
      expect(rowPresentation({ ...shell, mutationEvidence: { ...evidence, applied: 1, retainedFiles: 1, added: 1, omissions: 1 } }).name).toBe("Write")
    }
  })

  it("counts retained files separately from sensitive omissions and retained line remainders", async () => {
    const truncated = await buildMutationFileEvidence({
      path: "long.ts", mutationId: "m", before: { kind: "absent" },
      after: { kind: "text", text: "line\n".repeat(1001) },
    }, async () => {})
    expect(truncated?.omittedLines).toBe(1)
    const omitted = await buildMutationFileEvidence({
      path: "secret", mutationId: "secret", before: { kind: "absent" },
      after: { kind: "text", text: `token: ${["sk", "proj", "aB3".repeat(12)].join("-")}\n` },
    }, async () => {})
    expect(omitted?.patch).toEqual({ kind: "omitted", reason: "sensitive" })
    const summary = await buildMutationEvidence([
      { kind: "applied", file: { ...truncated!, conflictMarkers: true } },
      { kind: "not_applied", path: "blocked", reason: "changed" },
      { kind: "applied", file: omitted! },
    ], async () => {})
    expect(summary).toMatchObject({ applied: 2, retainedFiles: 1, omissions: 2, added: 2, conflictMarkers: 1, notApplied: 1 })
    expect(conflictMarkersNotice(summary)).toBe("Flywheel added conflict markers where the project changed the same lines as the command: long.ts")
    expect(notAppliedNotice(summary)).toBe("Not applied, because the project also changed these files: blocked (changed)")
  })

  it("keeps canonical file keys, display headings, missing windows and sensitive omissions distinct", () => {
    const reference = { version: 1 as const, root: "b".repeat(64), bytes: 100, sha256: "c".repeat(64) }
    const file: MutationFileEvidence = {
      version: 1, mutationId: "m", path: "/workspace/new.ts", displayPath: "new.ts", change: "added",
      before: null, after: { bytes: 10, sha256: "d".repeat(64) },
      retainedLines: 2, renderedLines: 5, omittedLines: 3, addedLines: 2, removedLines: 0,
      conflictMarkers: false, patch: { kind: "retained", reference },
    }
    const body = selectFileChangeBody({ ...tool, status: "error", errorMessage: "failed", mutationEvidence: evidence }, undefined)
    const files = { status: "ready" as const, offset: 0, nextOffset: null, files: [{ kind: "applied" as const, file }] }
    expect(fileDiffFiles(body, true, "added", { files, patch: { status: "unavailable", reference, text: "", nextOffset: null, complete: false } })[0])
      .toMatchObject({ id: "/workspace/new.ts", path: "new.ts", presentation: "write", evidenceStatus: "unavailable", rows: [], omittedLines: 5 })
    expect(fileDiffFiles(body, true, "added", { files, patch: { status: "ready", reference, text: "@@ -0,0 +1,2 @@\n+first\n+part", nextOffset: 30, complete: false } })[0])
      .toMatchObject({ evidenceStatus: "ready", sourceOmittedLines: 3, omittedLines: 3, rows: [{ text: "first", partial: false }, { text: "part", partial: true }] })
    const sensitive = { ...files, files: [{ kind: "applied" as const, file: { ...file, patch: { kind: "omitted" as const, reason: "sensitive" as const } } }] }
    expect(fileDiffFiles(body, true, "added", { files: sensitive })[0]).toMatchObject({ evidenceStatus: "omitted", omissionReason: "sensitive", rows: [] })
    expect(body.kind).toBe("actual")
  })

  it("uses identical small notices and bounded shared remainders", () => {
    expect(notAppliedNotice({ ...evidence, notApplied: 1, samples: [{ kind: "not_applied", path: "a.bin", reason: "binary files are not merged" }] })).toBe("Not applied, because the project also changed these files: a.bin (binary files are not merged)")
    expect(conflictMarkersNotice({ ...evidence, conflictMarkers: 1, samples: [{ kind: "applied", path: "a.ts", conflictMarkers: true }] })).toBe("Flywheel added conflict markers where the project changed the same lines as the command: a.ts")
    expect(notAppliedNotice({ ...evidence, notApplied: 5000, samples: [0, 1, 2].map(index => ({ kind: "not_applied", path: `${index}.ts`, reason: "changed" })) })).toBe("Not applied, because the project also changed these files: 0.ts (changed), 1.ts (changed), 2.ts (changed), and 4997 more not-applied files (expand this result)")
    expect(conflictMarkersNotice({ ...evidence, conflictMarkers: 5000, samples: [0, 1, 2].map(index => ({ kind: "applied", path: `${index}.ts`, conflictMarkers: true })) })).toBe("Flywheel added conflict markers where the project changed the same lines as the command: 0.ts, 1.ts, 2.ts, and 4997 more files (open Session Changes)")
  })
  it("names a running shell mutation Edit without its command, landed files Write or Edit, and a settled mutation that landed nothing by its command", async () => {
    const declared = { declaresMutation: true as const, status: "completed" as const, presentation: { name: "Bash", detail: "bun generate.ts" } }
    const added = { path: "src/new.ts", change: "added" as const, unifiedDiff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+const created = true\n" }
    const modified = { path: "src/old.ts", change: "modified" as const, unifiedDiff: "--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1 +1 @@\n-old\n+new\n" }
    const running = { name: "Edit", detail: SHELL_MUTATION_RUNNING }
    for (const status of ["pending", "streaming"] as const) expect(rowPresentation({ ...declared, status }, false)).toEqual(running)
    // Detached or background work still runs after the call itself settled.
    expect(rowPresentation(declared, true)).toEqual(running)
    expect(rowPresentation(declared, false)).toEqual(declared.presentation)
    const single = await mutationEvidenceFixture({ version: 1, files: [added], omissions: [] })
    const mixed = await mutationEvidenceFixture({ version: 1, files: [added, modified], omissions: [] })
    try {
      expect(rowPresentation({ ...declared, mutationEvidence: single.evidence }, true)).toEqual({ name: "Write", detail: "src/new.ts" })
      expect(rowPresentation({ ...declared, mutationEvidence: mixed.evidence })).toEqual({ name: "Edit", detail: "src/new.ts, src/old.ts" })
    } finally { single.reader.dispose(); mixed.reader.dispose() }
    const diff: MutationDiff = { version: 1, files: [added, modified, { ...modified, path: "src/removed.ts", change: "removed" }], omissions: [] }
    expect((await diffModels(diff, false, rowWritePolicy(declared))).map((file) => file.presentation)).toEqual(["write", "edit", "edit"])
    expect((await diffModels(diff, false, rowWritePolicy(tool))).map((file) => file.presentation)).toEqual(["edit", "edit", "edit"])
    // A Write that replaced a file landed a real diff, so only its added files show as source.
    expect((await diffModels(diff, false, rowWritePolicy({ fileChangeKind: "create" }))).map((file) => file.presentation)).toEqual(["write", "edit", "edit"])
  })
  it.each(["create", "replace", "patch"] as const)("keeps the first twenty %s rows through streaming and retention limits", (kind) => {
    const input = createProvisionalDiffInput(kind)
    if (kind === "patch") input.append({ input: "*** Begin Patch\n*** Add File: a.txt\n" }, [])
    const append = (text: string) => input.append(
      kind === "patch" ? { input: text } : kind === "replace" ? { new_string: text } : { content: text }, [],
    )
    const body = () => ({ kind: "proposed" as const, proposedDiff: input.snapshot() })
    for (let i = 0; i < 20; i++) append(`${kind === "patch" ? "+" : ""}line ${i}\n`)
    const writes = rowWritePolicy({ fileChangeKind: kind })
    expect(fileDiffFiles(body(), false, writes)[0]!.presentation).toBe(kind === "create" ? "write" : "edit")
    const head = fileDiffFiles(body(), false, writes)[0]!.rows
    append(`${kind === "patch" ? "+" : ""}line 20`)
    expect(fileDiffFiles(body())[0]!.rows).toEqual(head)
    expect(fileDiffFiles(body(), true)[0]!.rows.at(-1)).toMatchObject({ text: "line 20", partial: true })
    append("\n")
    for (let i = 21; i < 1001; i++) append(`${kind === "patch" ? "+" : ""}line ${i}\n`)
    expect(fileDiffFiles(body())[0]!.rows).toEqual(head)
    const expanded = fileDiffFiles(body(), true)[0]!
    expect(expanded.rows).toHaveLength(1000)
    expect(expanded.rows.at(-1)?.text).toBe("line 999")
    expect(expanded.omittedLines).toBe(1)
  })
  it("accepts ordinary text, a proposal, or a preview check, but never mixed variants", () => {
    const decode = Schema.decodeUnknownSync(Schema.Struct({
      streamingToolText: Schema.optionalKey(Schema.Record(Schema.String, ToolStreamingTextSchema)),
    }))

    expect(decode({ streamingToolText: { text: { content: "hello", filetype: "text" } } }).streamingToolText).toEqual({ text: { content: "hello", filetype: "text" } })
    expect(decode({ streamingToolText: { edit: { proposedDiff: proposal } } }).streamingToolText).toEqual({ edit: { proposedDiff: proposal } })
    expect(decode({ streamingToolText: { edit: { previewCheck: "Review this" } } }).streamingToolText).toEqual({ edit: { previewCheck: "Review this" } })
    expect(() => decode({ streamingToolText: { invalid: { content: "hello", proposedDiff: proposal } } })).toThrow()
    expect(() => decode({ streamingToolText: { invalid: { content: "hello", previewCheck: "Review this" } } })).toThrow()
    expect(() => decode({ streamingToolText: { invalid: { proposedDiff: proposal, previewCheck: "Review this" } } })).toThrow()
  })

  it("selects retained evidence independently of the command outcome and keeps proposals separate", () => {
    const actual = { kind: "actual" as const, mutationEvidence: evidence, pendingProposal: { kind: "proposed" as const, proposedDiff: proposal } }
    for (const row of [
      { ...tool, status: "completed" as const },
      { ...tool, status: "interrupted" as const },
      { ...tool, status: "error" as const, errorMessage: "failed" },
      { ...tool, status: "blocked" as const, statusMessage: "waiting" },
    ]) expect(selectFileChangeBody({ ...row, mutationEvidence: evidence }, { proposedDiff: proposal })).toEqual(actual)
    expect(selectFileChangeBody({ ...tool, status: "completed" }, { proposedDiff: proposal })).toEqual({ kind: "unavailable" })
    expect(selectFileChangeBody({ ...tool, status: "completed" }, undefined, { blockId: `tool:${tool.id}`, mutationEvidence: evidence })).toEqual({ kind: "actual", mutationEvidence: evidence })
    expect(selectFileChangeBody(tool, { proposedDiff: proposal })).toEqual({ kind: "proposed", proposedDiff: proposal })
    expect(selectFileChangeBody(tool, { previewCheck: "Review this" })).toEqual({ kind: "advisory", message: "Review this" })
    expect(selectFileChangeBody(tool, { content: "ordinary output" })).toEqual({ kind: "unavailable" })
    expect(selectFileChangeBody({ ...tool, fileChangeKind: undefined, name: "edit" }, { proposedDiff: proposal })).toEqual({ kind: "unavailable" })
  })

  it("applies terminal precedence before preview advice and proposal fallback", () => {
    expect(selectFileChangeBody({ ...tool, status: "error", errorMessage: "failed" }, { previewCheck: "Review this" })).toEqual({ kind: "unavailable" })
    expect(selectFileChangeBody({ ...tool, status: "completed", mutationEvidence: evidence }, { previewCheck: "Review this" })).toEqual({ kind: "actual", mutationEvidence: evidence })
    expect(selectFileChangeBody({ ...tool, status: "completed" }, { previewCheck: "Review this" })).toEqual({ kind: "unavailable" })
    expect(selectFileChangeBody({ ...tool, proposedDiff: proposal }, { previewCheck: "Review this" })).toEqual({ kind: "advisory", message: "Review this" })
    expect(fileDiffFiles({ kind: "advisory", message: "Review this" })).toEqual([])
  })

  it.each([undefined, evidence])("keeps the registered kind through streamed settlement and selects only canonical evidence (%j)", (mutationEvidence) => {
    const output = new OutputProjector({ executionCwd: "/workspace" })
    const events = new RuntimeEventProjector(output)
    events.dispatch(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      message: { content: [{ type: "tool_use", id: tool.id, name: "edit", input: {} }] },
    }))
    events.dispatch(createRuntimeEvent("tool.input.delta", {
      type: "tool.input.delta",
      tool_use_id: tool.id,
      partial_json: JSON.stringify({ path: "a.ts", old_string: "old", new_string: "new" }),
    }))
    events.dispatch(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed",
      tool_use: { id: tool.id, name: "edit", input: { path: "a.ts", old_string: "old", new_string: "new" } },
    }))
    events.dispatch(createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: tool.id,
      content: [{ type: "text", text: "ok" }],
      is_error: false,
      details: mutationEvidence === undefined ? {} : { mutationEvidence },
    }))

    const settled = output.getBlocks().find((block): block is FrontendToolEntry => block.kind === "tool")
    expect(settled?.fileChangeKind).toBe("replace")
    expect(settled?.proposedDiff).toBeUndefined()
    expect(settled && selectFileChangeBody(settled, undefined)).toEqual(mutationEvidence === undefined ? { kind: "unavailable" } : { kind: "actual", mutationEvidence })
  })

  it("keeps a successful file tool without mutation exclusive from its proposal", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" })
    const events = new RuntimeEventProjector(output)
    events.dispatch(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      message: { content: [{ type: "tool_use", id: "write-empty", name: "write", input: { path: "empty.ts", content: "" } }] },
    }))
    events.dispatch(createRuntimeEvent("tool.result.recorded", {
      type: "tool.result.recorded",
      tool_use_id: "write-empty",
      content: [{ type: "text", text: "ok" }],
      is_error: false,
    }))

    const settled = output.getBlocks().find((block): block is FrontendToolEntry => block.kind === "tool")
    expect(settled?.fileChangeKind).toBe("create")
    expect(settled?.proposedDiff).toBeUndefined()
    expect(settled && selectFileChangeBody(settled, undefined)).toEqual({ kind: "unavailable" })
  })

  it("accepts a hydrated evidence root only for the same block identity", () => {
    const completed = { ...tool, status: "completed" as const }
    expect(selectFileChangeBody(completed, undefined, { blockId: `tool:${tool.id}`, mutationEvidence: evidence })).toEqual({ kind: "actual", mutationEvidence: evidence })
    expect(selectFileChangeBody(completed, undefined, { blockId: "other", mutationEvidence: evidence })).toEqual({ kind: "unavailable" })
  })

  it("accepts structural and hydrated proposals when transient evidence is absent", () => {
    expect(selectFileChangeBody({ ...tool, proposedDiff: proposal }, undefined)).toEqual({ kind: "proposed", proposedDiff: proposal })
    expect(selectFileChangeBody(tool, undefined, { blockId: `tool:${tool.id}`, proposedDiff: proposal })).toEqual({ kind: "proposed", proposedDiff: proposal })
    expect(selectFileChangeBody({ ...tool, status: "completed" }, { proposedDiff: proposal }, { blockId: `tool:${tool.id}`, proposedDiff: proposal })).toEqual({ kind: "unavailable" })
    expect(selectFileChangeBody({ ...tool, proposedDiff: proposal }, { proposedDiff: { files: [], unavailable: "malformed" } }))
      .toEqual({ kind: "proposed", proposedDiff: { files: [], unavailable: "malformed" } })
  })

  it("parses canonical mutation rows with true coordinates and source marker text", () => {
    const rows = parseMutationDiffRows({
      version: 1,
      files: [{
        path: "src/a.ts",
        change: "modified",
        unifiedDiff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +20,4 @@\n context\n--- source marker\n+++ target marker\n-old\n+new",
      }],
      omissions: [],
    })
    expect(rows).toEqual([
      { path: "src/a.ts", kind: "context", text: "context", oldLine: 10, newLine: 20 },
      { path: "src/a.ts", kind: "remove", text: "-- source marker", oldLine: 11 },
      { path: "src/a.ts", kind: "add", text: "++ target marker", newLine: 21 },
      { path: "src/a.ts", kind: "remove", text: "old", oldLine: 12 },
      { path: "src/a.ts", kind: "add", text: "new", newLine: 22 },
    ])
  })

  it("selects each file head and counts producer and compact omissions", () => {
    const proposedDiff: ProvisionalDiff = { files: ["a", "b"].map((id) => ({
      id, path: `${id}.ts`, action: "update", movePath: `${id}-moved.ts`,
      hunks: [{
        id: "h", oldStart: 11, newStart: 21, omittedBefore: 3, omittedAfter: 4,
        lines: Array.from({ length: 25 }, (_, i) => ({ id: String(i), kind: "context", text: `line ${i}`, partial: i === 22 })),
      }],
    })) }
    const compact = fileDiffFiles({ kind: "proposed", proposedDiff })
    for (const file of compact) {
      expect(file.rows).toHaveLength(20)
      expect(file.rows[0]).toMatchObject({ id: "0", oldLine: 11, newLine: 21 })
      expect(file.rows.at(-1)).toMatchObject({ id: "19", partial: false })
      expect(file.omittedLines).toBe(12)
      expect(file.movePath).toBe(`${file.id}-moved.ts`)
    }
    const expanded = fileDiffFiles({ kind: "proposed", proposedDiff }, (file) => file.path === "b.ts")
    expect(expanded.map((file) => file.rows.length)).toEqual([20, 25])
    expect(expanded.map((file) => file.omittedLines)).toEqual([12, 7])
  })
  it("shows the proposal head and does not invent coordinates", () => {
    const proposedDiff: ProvisionalDiff = { files: [{
      id: "file-0", action: "add", hunks: [{ id: "h", omittedBefore: 0, omittedAfter: 0,
        lines: Array.from({ length: 25 }, (_, i) => ({ id: String(i), kind: "add", text: String(i), partial: i === 24 })),
      }],
    }] }
    const file = fileDiffFiles({ kind: "proposed", proposedDiff })[0]!
    expect(file.rows[0]?.id).toBe("0")
    expect(file.rows.at(-1)?.id).toBe("19")
    expect("oldLine" in file.rows[0]!).toBe(false)
    expect("newLine" in file.rows[0]!).toBe(false)
  })
  it("preserves canonical actions and independent heads when omitted files leave the list", async () => {
    const mutation = { version: 1 as const, omissions: [{ path: "secret", reason: "sensitive" as const }],
      files: (["added", "removed", "modified"] as const).map((change) => ({
        path: `${change}.ts`,
        change,
        unifiedDiff: `@@ -1,25 +1,25 @@\n${Array.from({ length: 25 }, (_, i) => ` row ${i}`).join("\n")}`,
      })),
    }
    const files = await diffModels(mutation, (file) => file.path === "removed.ts")
    expect(files.map((file) => file.action)).toEqual(["add", "delete", "update"])
    expect(files.map((file) => file.rows.length)).toEqual([20, 25, 20])
    expect(files.map((file) => file.rows[0]?.oldLine)).toEqual([1, 1, 1])
    const remaining = await diffModels({ ...mutation, files: mutation.files.slice(1) }, (file) => file.path === "removed.ts")
    expect(remaining.map((file) => file.rows.length)).toEqual([25, 20])
  })

  it("shows shell mutation evidence for every outcome and settled output only without evidence", () => {
    const bash: FrontendToolEntry = { kind: "tool", id: "bash-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "reshape" }, status: "completed", timestamp: 1, declaresMutation: true, mutationEvidence: evidence }
    expect(selectFileChangeBody(bash, undefined)).toEqual({ kind: "actual", mutationEvidence: evidence })
    // A command that timed out still landed its edits.
    expect(selectFileChangeBody({ ...bash, status: "error", errorMessage: "timed out" }, undefined)).toEqual({ kind: "actual", mutationEvidence: evidence })
    // A declared edit that is still running has no file body yet.
    const { mutationEvidence: _evidence, ...pending } = bash
    expect(selectFileChangeBody({ ...pending, status: "pending" }, undefined)).toEqual({ kind: "unavailable" })
    expect(showsShellMutationOutput(bash, false)).toBe(false)
    expect(showsShellMutationOutput({ ...pending, status: "pending" }, false)).toBe(false)
    expect(showsShellMutationOutput({ ...pending, status: "streaming" }, false)).toBe(false)
    for (const settled of [
      pending,
      { ...pending, status: "error" as const, errorMessage: "refused" },
      { ...pending, status: "blocked" as const, statusMessage: "held" },
      { ...pending, status: "interrupted" as const },
    ]) {
      expect(showsShellMutationOutput(settled, false)).toBe(true)
      expect(showsShellMutationOutput(settled, true)).toBe(false)
    }
    expect(showsShellMutationOutput({ ...pending, declaresMutation: undefined }, false)).toBe(false)
    expect(showsShellMutationOutput({ ...pending, mutationEvidence: { ...evidence, applied: 0, omissions: 0 } }, false)).toBe(true)
    const omitted = { ...evidence, applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1 }
    expect(showsShellMutationOutput({ ...pending, mutationEvidence: omitted }, false)).toBe(false)
    expect(showsShellMutationOutput(pending, false, { blockId: "tool:bash-1", mutationEvidence: evidence })).toBe(false)
    expect(showsShellMutationOutput(pending, false, { blockId: "tool:bash-1", mutationEvidence: omitted })).toBe(false)
    expect(showsShellMutationOutput(pending, false, { blockId: "tool:another", mutationEvidence: evidence })).toBe(true)
  })
})
