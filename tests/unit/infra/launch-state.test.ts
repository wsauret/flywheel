import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { launchOutbox, takeLaunchState, writeLaunchState, type LaunchState } from "../../../src/infra/launch-state.js"

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-launch-state-"))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const state: LaunchState = {
  version: 3,
  projectRoot: "/work/project",
  foreground: "session-b",
  tabs: ["session-a", "session-b"],
  scroll: {
    "session-a": { tail: true },
    "session-b": { blockIndex: 7, rowOffsetWithinBlock: 3 },
  },
  disclosure: { "session-b": { "tool:call-1": true, "tool:call-2": false } },
  drafts: {
    "session-b": {
      text: "half a thought [Image #1]",
      pastes: [{ start: 0, end: 4, text: "half" }],
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0KGgo=" }],
      caret: 7,
    },
  },
  questionDrafts: { "session-a": { "call-9": { tab: 1, cursor: 2, answers: [{ picked: [0], freeformPicked: false }], editorText: [["line"]] } } },
  modal: { kind: "child", sessionId: "child-1" },
}

describe("launch state", () => {
  test("converts a previous subagent leaf route without losing drafts or saved tabs", () => {
    const path = join(scratch(), "legacy.json")
    writeFileSync(path, JSON.stringify({ ...state, version: 1, modal: { kind: "subagent", sessionId: "child-1" } }))
    expect(takeLaunchState(path, state.projectRoot)).toEqual({ kind: "restore", state })
    expect(existsSync(path)).toBe(false)
  })
  test("round-trips through a private file that the reader deletes", () => {
    const dir = scratch()
    const path = writeLaunchState(dir, state)
    expect(path.startsWith(dir)).toBe(true)
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(takeLaunchState(path, state.projectRoot)).toEqual({ kind: "restore", state })
    expect(existsSync(path)).toBe(false)
  })

  test("round-trips a workflow agent's route", () => {
    const agent: LaunchState = { ...state, modal: { kind: "module", moduleId: "workflows", route: { workflowId: "workflow-1", agentNodeId: "lanes:1:probe", follow: false } } }
    expect(takeLaunchState(writeLaunchState(scratch(), agent), state.projectRoot)).toEqual({ kind: "restore", state: agent })
    const previous = join(scratch(), "previous.json")
    writeFileSync(previous, JSON.stringify({ ...state, version: 2, modal: { kind: "workflowAgent", sessionId: "workflow-1", agentNodeId: "lanes:1:probe", follow: false } }))
    expect(takeLaunchState(previous, state.projectRoot)).toEqual({ kind: "restore", state: agent })
  })

  test("carries the messages that wait for the connection, and reads a file that a build before them wrote as none waiting", () => {
    const waiting: LaunchState = { ...state, outbox: [
      { sessionId: "session-b", id: "submission-1", input: { text: "first [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0KGgo=" }], submissionIds: ["submission-1"] }, timestamp: 10 },
      { sessionId: "session-b", id: "submission-2", input: { text: "second", invocation: { label: "Review", args: "second" }, submissionIds: ["submission-2"] }, timestamp: 11 },
    ] }
    expect(takeLaunchState(writeLaunchState(scratch(), waiting), state.projectRoot)).toEqual({ kind: "restore", state: waiting })
    // The previous shape of version 3 has no outbox field.
    const previous = join(scratch(), "previous-v3.json")
    writeFileSync(previous, JSON.stringify(state))
    const taken = takeLaunchState(previous, state.projectRoot)
    expect(taken).toEqual({ kind: "restore", state })
    expect(taken.kind === "restore" ? launchOutbox(taken.state) : undefined).toEqual([])
  })

  test("refuses a field the current version does not declare", () => {
    const dir = scratch()
    const path = join(dir, "excess.json")
    writeFileSync(path, JSON.stringify({ ...state, unexpected: 1 }))

    expect(takeLaunchState(path, state.projectRoot).kind).toBe("plain")
  })

  test("starts plain for a file it cannot read or parse", () => {
    const dir = scratch()
    expect(takeLaunchState(join(dir, "missing.json"), state.projectRoot).kind).toBe("plain")
    const garbled = join(dir, "garbled.json")
    writeFileSync(garbled, "{ not json")
    expect(takeLaunchState(garbled, state.projectRoot).kind).toBe("plain")
    expect(existsSync(garbled)).toBe(false)
  })

  test("starts plain when the state names another project", () => {
    const dir = scratch()
    const path = writeLaunchState(dir, state)
    const taken = takeLaunchState(path, "/work/other")
    expect(taken.kind).toBe("plain")
    expect(readFileSyncOrNull(path)).toBeNull()
  })
})

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
