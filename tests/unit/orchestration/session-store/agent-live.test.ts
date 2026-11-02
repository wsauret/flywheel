import { expect, test } from "bun:test"
import { agentLive } from "../../../../src/orchestration/modules/workflows/compact-activity.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { OutputProjector } from "../../../../src/infra/output/output-projector.js"
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js"
import { buildMutationDiffEntries } from "../../../../src/infra/mutation-diff-evidence.js"
import { buildMutationEvidence } from "../../../../src/infra/mutation-evidence.js"
import { sessionContentFixture } from "../../../helpers/session-content.js"

test("derives compact activity from the member's ordinary transcript without publishing a second transcript", () => {
  const output = createOutputSession({ executionCwd: "/scratch", updateEntry: () => {} })
  try {
    output.dispatchRuntimeEvent(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed", tool_use: { id: "bash", name: "bash", input: { command: "git diff --name-only" } },
    }))
    expect(agentLive("member", "attempt", 1, output.getBlocks(), "executing_tools", { duration: 0 })).toMatchObject({ activity: { name: "Diffed", detail: "working tree" } })
    output.dispatchRuntimeEvent(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed", tool_use: { id: "read", name: "read", input: { path: "parser.ts" } },
    }))
    const compact = agentLive("member", "attempt", 2, output.getBlocks(), "executing_tools", { duration: 0 })
    expect(compact.activity).toEqual({ name: "Read", detail: "parser.ts" })
    expect(compact.tail).toBeUndefined()
  } finally { output.dispose() }
})

test("keeps the previous call while the next call's input streams, then moves to it in one step", () => {
  const projector = new OutputProjector({ executionCwd: "/scratch" })
  const activity = () => agentLive("member", "attempt", 1, projector.getBlocks(), "executing_tools", { duration: 0 }).activity
  projector.apply({ type: "tool-input-complete", toolUseId: "read", name: "read", input: { path: "parser.ts" }, timestamp: 1 })
  projector.apply({ type: "tool-result", toolUseId: "read", outcome: "ok", content: [{ type: "text", text: "x" }], timestamp: 2 })
  const previous = { name: "Read", detail: "parser.ts" }
  expect(activity()).toEqual(previous)

  projector.apply({ type: "tool-use", toolUseId: "search", name: "bash", input: {}, timestamp: 3 })
  expect(activity()).toEqual(previous)
  for (const partialJson of ['{"command":"rg -n ', '\\"agentLive\\" src"}']) {
    projector.apply({ type: "tool-input-delta", toolUseId: "search", partialJson })
    expect(activity()).toEqual(previous)
  }
  projector.apply({ type: "tool-input-complete", toolUseId: "search", name: "bash", input: { command: "rg -n \"agentLive\" src" }, timestamp: 4 })
  expect(activity()).toEqual({ name: "Searched", detail: "agentLive in src" })
})

test("moves compact conversation revision when the ordinary transcript gains a committed block", () => {
  const output = createOutputSession({ executionCwd: "/scratch", updateEntry: () => {} })
  const revision = () => agentLive("member", "attempt", 0, output.getBlocks(), "generating", { duration: 0 }).revision
  try {
    const initial = revision()
    output.dispatchRuntimeEvent(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded", entry_id: "assistant-entry", message: { content: [{ type: "text", text: "Reading the parser." }] },
    }))
    const said = revision()
    expect(said).toBeGreaterThan(initial)
    output.dispatchRuntimeEvent(createRuntimeEvent("tool.input.completed", {
      type: "tool.input.completed", tool_use: { id: "call", name: "read", input: { path: "parser.ts" } },
    }))
    expect(revision()).toBeGreaterThan(said)
  } finally { output.dispose() }
})

test("names the files a mutating command changed once its changes land, and what it names before then", async () => {
  const projector = new OutputProjector({ executionCwd: "/workspace" })
  const runtime = new RuntimeEventProjector(projector)
  const { stage } = sessionContentFixture()
  const change = (path: string, kind: "added" | "modified") => ({ path, change: kind, unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n` })
  const evidence = async (id: string, files: ReturnType<typeof change>[]) =>
    buildMutationEvidence(await buildMutationDiffEntries({ version: 1, files, omissions: [] }, id, stage), stage)
  const activity = () => agentLive("member", "attempt", 1, projector.getBlocks(), "executing_tools", { duration: 0 }).activity

  projector.apply({ type: "tool-use", toolUseId: "rewrite", name: "bash", input: { mutates: true, command: "python3 scripts/rewrite.py" }, timestamp: 1 })
  expect(activity()).toEqual({ name: "Edited", detail: "files with rewrite.py" })
  runtime.dispatch({ type: "tool.execution_output.recorded", data: { tool_use_id: "rewrite", output: "", mutationEvidence: await evidence("rewrite", [change("src/a.ts", "modified"), change("src/b.ts", "modified")]) } })
  projector.apply({ type: "tool-result", toolUseId: "rewrite", outcome: "ok", content: [{ type: "text", text: "done" }], timestamp: 2 })
  expect(activity()).toEqual({ name: "Edited", detail: "a.ts, b.ts" })

  projector.apply({ type: "tool-use", toolUseId: "create", name: "bash", input: { mutates: true, command: "bun run scripts/generate.ts" }, timestamp: 3 })
  runtime.dispatch({ type: "tool.execution_output.recorded", data: { tool_use_id: "create", output: "", mutationEvidence: await evidence("create", [change("gen/x.ts", "added")]) } })
  projector.apply({ type: "tool-result", toolUseId: "create", outcome: "ok", content: [{ type: "text", text: "done" }], timestamp: 3 })
  expect(activity()).toEqual({ name: "Wrote", detail: "x.ts" })
})
