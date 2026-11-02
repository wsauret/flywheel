import assert from "node:assert/strict"
import { describe, test } from "bun:test"
import { createRoot } from "solid-js"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { foldTranscript } from "../../../src/protocol/client/transcript-model.js"
import { createBlockDisclosure } from "../app/block-disclosure.js"
import { createBlockLanding } from "../app/transcript-scroll.js"
import { presentWebTranscript, rowHolding, rowIdentity, rowIndex, toolWorkCounts, type TranscriptViewRow } from "./tool-runs.js"
import { createTurnFolds, foldWebTurns, turnCalls, turnFoldSummary, turnChangedFiles } from "./turn-folds.js"
import type { MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"

const person: FrontendOutputBlock = { kind: "userMessage", id: "person", content: "Do it", timestamp: 1000, pending: false, injected: false }
const narration: FrontendOutputBlock = { kind: "text", id: "narration", content: "Working", timestamp: 2000 }
const answer: FrontendOutputBlock = { kind: "text", id: "answer", content: "Done", timestamp: 373000 }
const command: FrontendOutputBlock = { kind: "tool", id: "command", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "pwd" }, status: "completed", timestamp: 3000 }
const viewOf = (blocks: readonly FrontendOutputBlock[]) => presentWebTranscript(foldTranscript(blocks, true))
const kinds = (blocks: readonly FrontendOutputBlock[], atRest = true) => foldWebTurns(viewOf(blocks), atRest).rows.map(row => row.kind)

test("reference turn counts use metadata display paths but review groups canonical files in call order", () => {
  const first: Extract<MutationFilesView["files"][number], { kind: "applied" }>["file"] = {
    version: 1, mutationId: "first", path: "/project/src/a.ts", displayPath: "src/a.ts", change: "modified",
    before: null, after: null, retainedLines: 2, renderedLines: 2, omittedLines: 0, addedLines: 1, removedLines: 1, conflictMarkers: false,
    patch: { kind: "retained", reference: { version: 1, root: "1".repeat(64), bytes: 24, sha256: "2".repeat(64) } },
  }
  const second = { ...first, mutationId: "second", path: "/project/src/../src/a.ts", displayPath: "./src/a.ts", addedLines: 2, omittedLines: 12 }
  const privateFile = { ...first, path: "/project/.flywheel/private.ts", displayPath: ".flywheel/private.ts" }
  const omitted = { ...first, path: "/project/secret.ts", displayPath: "secret.ts", addedLines: 0, removedLines: 0, patch: { kind: "omitted" as const, reason: "sensitive" as const } }
  const entries = [{ kind: "applied" as const, file: first }, { kind: "applied" as const, file: privateFile }, { kind: "applied" as const, file: omitted }, { kind: "not_applied" as const, path: "ignored.ts", reason: "conflict" }]
  const summary: NonNullable<FrontendToolEntry["mutationEvidence"]> = {
    version: 2, manifest: { version: 1, root: "3".repeat(64), bytes: 2048, entries: entries.length },
    applied: 3, retainedFiles: 2, omissions: 1, notApplied: 1, added: 0, modified: 3, removed: 0, addedLines: 2, removedLines: 2, conflictMarkers: 0, samples: [],
  }
  const call: FrontendToolEntry = { ...command, fileChangeKind: "patch", mutationEvidence: summary }
  const again: FrontendToolEntry = { ...call, id: "again" }
  const metadata = new Map<string, MutationFilesView>([
    [call.id, { status: "ready", offset: 0, files: entries, nextOffset: null }],
    [again.id, { status: "ready", offset: 0, files: [{ kind: "applied", file: second }], nextOffset: null }],
  ])
  assert.equal(toolWorkCounts([call, again], metadata).editedFiles, 4)
  const partialMetadata = new Map<string, MutationFilesView>([...metadata, [again.id, { status: "ready", offset: 0, files: [], nextOffset: 0 }]])
  assert.equal(toolWorkCounts([call, again], partialMetadata).editedFiles, 3)
  assert.equal(toolWorkCounts([call, again], partialMetadata).complete, false)
  const fold = foldWebTurns(viewOf([person, call, again, answer]), true).rows[1]
  assert.ok(fold?.kind === "turnFold")
  assert.match(turnFoldSummary(fold, metadata).label, /edited 4 files/)
  assert.match(turnFoldSummary(fold, partialMetadata).label, /edited 3 files \(incomplete\)/)
  const files = turnChangedFiles(fold, {}, { projectRoot: "/project", executionCwd: "/project" }, metadata)
  assert.deepEqual(files.map(file => [file.path, file.added, file.removed, file.partial, file.omissions]), [
    ["src/a.ts", 3, 2, true, []], ["secret.ts", 0, 0, true, ["sensitive"]],
  ])
  assert.deepEqual(files[0]?.edits.map(edit => "entry" in edit ? edit.entry.file.mutationId : undefined), ["first", "second"])
})

test("a settled turn folds its work, leaves its answer and restores every divider when opened", () => {
  const view = viewOf([person, narration, command, answer])
  const folded = foldWebTurns(view, true)
  assert.deepEqual(folded.rows.map(row => row.kind), ["userMessage", "turnFold", "text"])
  const opened = foldWebTurns(view, true, () => true)
  assert.deepEqual(opened.rows.filter(row => row.kind !== "turnFold"), view.rows)
  assert.deepEqual(opened.boundaryBefore.slice(2), view.boundaryBefore.slice(1))
  const fold = folded.rows[1]
  assert.ok(fold?.kind === "turnFold")
  assert.equal(turnFoldSummary(fold).label, "Worked 6m 12s · ran 1 command")
  assert.equal(rowIndex(opened.rows, [person, narration, command, answer], 40, fold.id), 41)
  assert.deepEqual(turnChangedFiles(fold), [])
})

test("returned input stays after a closed fold and appears once when opened", () => {
  const returned: FrontendOutputBlock = {
    kind: "system", id: "returned-input:child:person:send", message: "Explorer finished before reading your message:\n\nrename `foo` to `bar`", timestamp: 4000,
  }
  const ordinary: FrontendOutputBlock = { kind: "system", id: "ordinary", message: "Updated skill.", timestamp: 5000 }
  const view = viewOf([person, narration, command, returned, ordinary, answer])
  const folded = foldWebTurns(view, true)
  assert.deepEqual(folded.rows.map(row => row.kind), ["userMessage", "turnFold", "system", "text"])
  assert.equal(folded.rows[2], returned)
  const fold = folded.rows[1]
  assert.ok(fold?.kind === "turnFold")
  assert.ok(!fold.rows.includes(returned))
  assert.ok(fold.rows.includes(ordinary))
  const opened = foldWebTurns(view, true, () => true)
  assert.deepEqual(opened.rows.filter(row => row.kind !== "turnFold"), view.rows)
  assert.equal(opened.rows.filter(row => row === returned).length, 1)
})

test("turn changes sum parent edits per file and retain call order without child edits", async () => {
  const metadata = new Map<string, MutationFilesView>()
  const stored: Awaited<ReturnType<typeof mutationEvidenceFixture>>[] = []
  const edit = async (id: string, path: string, unifiedDiff: string, omittedLines = 0): Promise<FrontendToolEntry> => {
    const fixture = await mutationEvidenceFixture({
      version: 1, files: [{ path, change: "modified", unifiedDiff, omittedLines }], omissions: [],
    })
    stored.push(fixture)
    const handle = fixture.reader.open(id, fixture.evidence.manifest)
    await handle.loadFiles()
    metadata.set(id, handle.files)
    return { ...command, id, fileChangeKind: "patch", mutationEvidence: fixture.evidence }
  }
  try {
  const first = await edit("first", "src/a.ts", "@@ -1 +1,2 @@\n-old\n+first\n+second")
  const second = await edit("second", "src/a.ts", "@@ -1 +1 @@\n-first\n+third")
  const child: FrontendOutputBlock = {
    kind: "agentGroup", id: "agent", toolUseId: "child", containerKind: "subagent", label: "Explorer",
    description: "Find it", status: "completed", children: [await edit("child", "child.ts", "@@ -0,0 +1 @@\n+child")], totalToolCount: 1, timestamp: 5000,
  }
  const fold = foldWebTurns(viewOf([person, first, await edit("other", "b.ts", "@@ -0,0 +1 @@\n+other"), child, second, answer]), true).rows[1]
  assert.ok(fold?.kind === "turnFold")
  assert.equal(fold.answerId, "text:answer")
  const files = turnChangedFiles(fold, {}, undefined, metadata)
  assert.deepEqual(files.map(file => [file.path, file.added, file.removed]), [["src/a.ts", 3, 2], ["b.ts", 1, 0]])
  assert.deepEqual(files[0]?.edits.map(change => change.callId), ["first", "second"])
  const privateFold = foldWebTurns(viewOf([person, await edit("scratch", ".flywheel/sessions/scratch.ts", "@@ -0,0 +1 @@\n+scratch"), answer]), true).rows[1]
  assert.ok(privateFold?.kind === "turnFold")
  assert.deepEqual(turnChangedFiles(privateFold, {}, { projectRoot: "/project", executionCwd: "/project" }, metadata), [])
  const preview = await edit("preview", "src/a.ts", "@@ -1 +1 @@\n-old\n+new", 40)
  const previewFold = foldWebTurns(viewOf([person, preview, answer]), true).rows[1]
  assert.ok(previewFold?.kind === "turnFold")
  assert.equal(turnChangedFiles(previewFold, {}, undefined, metadata)[0]?.partial, true)
  const sensitiveFixture = await mutationEvidenceFixture({ version: 1, files: [], omissions: [{ path: "private.ts", reason: "sensitive" }] })
  stored.push(sensitiveFixture)
  const sensitiveHandle = sensitiveFixture.reader.open("sensitive", sensitiveFixture.evidence.manifest)
  await sensitiveHandle.loadFiles()
  metadata.set("sensitive", sensitiveHandle.files)
  const sensitiveFold = foldWebTurns(viewOf([person, { ...first, id: "sensitive", mutationEvidence: sensitiveFixture.evidence }, answer]), true).rows[1]
  assert.ok(sensitiveFold?.kind === "turnFold")
  assert.deepEqual(turnChangedFiles(sensitiveFold, {}, undefined, metadata).map(file => [file.path, file.added, file.removed, file.omissions]), [["private.ts", 0, 0, ["sensitive"]]])
  const external = await edit("external", "../other/a.ts", "@@ -0,0 +1 @@\n+external")
  assert.equal(turnChangedFiles({ rows: [external] }, {}, { projectRoot: "/project", executionCwd: "/project" }, metadata).length, 1)
  const windowsPrivate = await edit("private", "C:\\Project\\.flywheel\\scratch.ts", "@@ -0,0 +1 @@\n+private")
  assert.deepEqual(turnChangedFiles({ rows: [windowsPrivate] }, {}, { projectRoot: "C:\\Project", executionCwd: "C:\\Project" }, metadata), [])
  } finally { for (const fixture of stored) fixture.reader.dispose() }
})

test("running, unanswered, direct answers and reported errors stay open, but failed calls can fold", () => {
  assert.deepEqual(kinds([person, narration, command, answer], false), ["userMessage", "text", "toolGroup", "text"])
  assert.deepEqual(kinds([person, narration, command]), ["userMessage", "text", "toolGroup"])
  assert.deepEqual(kinds([person, command, narration, { kind: "question", toolUseId: "waiting", questions: [], timestamp: 4000 }]), ["userMessage", "toolGroup", "text", "question"])
  assert.deepEqual(kinds([person, answer]), ["userMessage", "text"])
  assert.deepEqual(kinds([person, command, { kind: "system", id: "error", message: "Failed", level: "error", timestamp: 4000 }, answer]), ["userMessage", "toolGroup", "system", "text"])
  assert.deepEqual(kinds([person, { ...command, exitCode: 1 }, answer]), ["userMessage", "turnFold", "text"])
  assert.deepEqual(kinds([person, narration, command, answer, { ...command, id: "later" }]), ["userMessage", "text", "toolGroup", "text", "toolGroup"])
})

test("the line counts parent commands, unique edited files and delegated runs; saved questions fold too", async () => {
  const fixture = await mutationEvidenceFixture({ version: 1, files: [{ path: "src/a.ts", change: "modified", unifiedDiff: "" }], omissions: [] })
  const handle = fixture.reader.open("counts", fixture.evidence.manifest)
  await handle.loadFiles()
  try {
  const edit: FrontendOutputBlock = {
    ...command, id: "edit", name: "edit", action: "file_edit", fileChangeKind: "patch",
    mutationEvidence: fixture.evidence,
  }
  const agent: FrontendOutputBlock = {
    kind: "agentGroup", id: "agent", toolUseId: "child", containerKind: "subagent", label: "Explorer",
    description: "Find it", status: "completed", children: [command], totalToolCount: 1, timestamp: 5000,
  }
  const question: FrontendOutputBlock = { kind: "question", toolUseId: "question", questions: [], answers: {}, timestamp: 6000 }
  assert.deepEqual(kinds([person, question, answer]), ["userMessage", "turnFold", "text"])
  const workflow: FrontendOutputBlock = { ...agent, id: "workflow", containerKind: "workflow" }
  const view = viewOf([person, command, edit, { ...edit, id: "edit-again" }, agent, workflow, question, answer])
  const folded = foldWebTurns(view, true)
  // The workflow's card stays in view after the fold, before the answer, and
  // the line does not count it.
  assert.deepEqual(folded.rows.map(row => row.kind === "agentGroup" ? row.containerKind : row.kind), ["userMessage", "turnFold", "workflow", "text"])
  const fold = folded.rows[1]
  assert.ok(fold?.kind === "turnFold")
  assert.equal(turnFoldSummary(fold, new Map([["edit", handle.files], ["edit-again", handle.files]])).label, "Worked 6m 12s · ran 1 command, edited 1 file, used 2 tools, 1 subagent")
  const opened = foldWebTurns(view, true, () => true)
  assert.equal(opened.rows.filter(row => row.kind === "agentGroup" && row.containerKind === "workflow").length, 1, "an open fold shows the card once, in its place")
  // A turn whose only work launched a workflow has nothing else to fold.
  assert.deepEqual(kinds([person, workflow, answer]), ["userMessage", "agentGroup", "text"])
  assert.equal(rowHolding(folded.rows, "tool:question"), fold.id)
  const failed = { ...agent, status: "error" as const, failure: { title: "Failed", message: "Failed", guidance: "" } }
  assert.deepEqual(kinds([person, failed, answer]), ["userMessage", "agentGroup", "text"])
  } finally { fixture.reader.dispose() }
})

test("a delivered mid-turn redirect does not settle narration, and partial spans stay open", () => {
  const redirected = foldWebTurns(viewOf([person, command, narration, { ...person, id: "redirect", timestamp: 4000 }]), false)
  assert.deepEqual(redirected.rows.map(row => row.kind), ["userMessage", "toolGroup", "text", "userMessage"])
  assert.deepEqual(redirected.boundaryBefore, [false, false, true, false])
  assert.deepEqual(kinds([command, answer]), ["toolGroup", "text"])
  const settled = foldWebTurns(viewOf([person, command, answer]), true)
  const foldId = rowIdentity(settled.rows[1]!)
  const nextTurn = viewOf([person, command, answer, { ...person, id: "next" }, { ...command, id: "next-command" }, { ...narration, id: "next-narration" }, { ...person, id: "redirect" }])
  const folded = foldWebTurns(nextTurn, false, undefined, new Set([foldId]))
  assert.deepEqual(folded.rows.map(row => row.kind), ["userMessage", "turnFold", "text", "userMessage", "toolGroup", "text", "userMessage"])
  assert.deepEqual(folded.boundaryBefore, [false, false, false, false, false, true, false])
})

describe("a turn the window opened inside", () => {
  const unchosen = () => undefined
  const running: FrontendOutputBlock = { ...command, status: "pending" }
  const identities = (rows: readonly TranscriptViewRow[]) => rows.map(rowIdentity)
  /** The open fold's line and changes summary read the fold row's own work. */
  const openFold = (rows: readonly TranscriptViewRow[]) => {
    const fold = rows.find(row => row.kind === "turnFold")
    assert.ok(fold?.kind === "turnFold", "the turn keeps its fold row")
    assert.equal(fold.open, true, "the fold arrives open")
    assert.equal(fold.answerId, "text:answer")
    assert.deepEqual(turnCalls(fold).map(call => call.id), ["command"], "the fold counts the turn's work")
    return fold
  }

  test("presents as an open fold when an older page brings its person message", () => {
    const folds = createTurnFolds()
    const seen = identities(folds(viewOf([command, narration, answer]), true, unchosen).rows)
    assert.deepEqual(seen, ["toolGroup:tool:command", "text:narration", "text:answer"])
    const paged = folds(viewOf([person, command, narration, answer]), true, unchosen).rows
    const fold = openFold(paged)
    assert.deepEqual(identities(paged), ["userMessage:person", fold.id, ...seen], "every row the reader saw keeps its key")
    assert.equal(folds(viewOf([person, command, narration, answer]), true, id => id === fold.id ? false : undefined).rows.find(row => row.kind === "turnFold")?.open, false, "the person's close holds against how it arrived")
    assert.deepEqual(folds(viewOf([person, command, narration, answer, { ...person, id: "next" }]), true, unchosen).rows.map(row => row.kind), ["userMessage", "turnFold", "toolGroup", "text", "text", "userMessage"], "later frames keep it open")
    assert.deepEqual(createTurnFolds()(viewOf([person, command, narration, answer]), true, unchosen).rows.map(row => row.kind), ["userMessage", "turnFold", "text"], "a window that opens on the whole turn folds it")
  })

  test("stays open through a running frame with no answer yet", () => {
    const folds = createTurnFolds()
    assert.deepEqual(identities(folds(viewOf([running]), false, unchosen).rows), ["toolGroup:tool:command"])
    assert.deepEqual(identities(folds(viewOf([person, running]), false, unchosen).rows), ["userMessage:person", "toolGroup:tool:command"])
    const settled = folds(viewOf([person, command, answer]), true, unchosen).rows
    assert.deepEqual(identities(settled), ["userMessage:person", openFold(settled).id, "toolGroup:tool:command", "text:answer"])
  })

  test("stays open when narration comes before a different final answer", () => {
    const folds = createTurnFolds()
    folds(viewOf([running, narration]), false, unchosen)
    folds(viewOf([person, command, narration]), false, unchosen)
    const settled = folds(viewOf([person, command, narration, answer]), true, unchosen).rows
    assert.deepEqual(identities(settled), ["userMessage:person", openFold(settled).id, "toolGroup:tool:command", "text:narration", "text:answer"])
  })

  test("keeps inherited openness through recovery independently of another session", () => {
    const folds = createTurnFolds()
    folds(viewOf([command, narration, answer]), true, unchosen)
    const paged = viewOf([person, command, narration, answer])
    assert.equal(openFold(folds(paged, true, unchosen).rows).open, true, "recovery keeps rows the reader saw")
    const other = createTurnFolds()
    assert.deepEqual(other(paged, true, unchosen).rows.map(row => row.kind), ["userMessage", "turnFold", "text"], "another session starts folded")
    assert.equal(openFold(folds(paged, true, unchosen).rows).open, true, "the resident session still owns its inherited openness")
  })
})

test("search disclosure opens the fold before rowHolding lands on its original work row", () => {
  createRoot(dispose => {
    const disclosure = createBlockDisclosure()
    let view = viewOf([])
    const current = () => foldWebTurns(view, true, id => disclosure.state("session", id)().open).rows
    const landing = createBlockLanding({
      rows: current,
      reveal: row => {
        if (row.kind === "turnFold") disclosure.setOpen("session", row.id, true)
      },
      center: () => true,
    })
    landing.land("tool:command")
    view = viewOf([person, command, answer])
    const closed = foldWebTurns(view, true)
    const foldId = rowHolding(closed.rows, "tool:command")
    assert.ok(foldId !== undefined && foldId.startsWith("turnFold:"))
    assert.equal(landing.reconcile(), true)
    const opened = foldWebTurns(view, true, id => disclosure.state("session", id)().open)
    assert.equal(rowHolding(opened.rows, "tool:command"), rowHolding(view.rows, "tool:command"))
    disclosure.setOpen("session", foldId, false)
    view = viewOf([person, command, answer, { ...person, id: "next" }])
    assert.equal(landing.reconcile(), false)
    const closedAgain = current()[1]
    assert.ok(closedAgain?.kind === "turnFold")
    assert.equal(closedAgain.open, false)
    dispose()
  })
})
