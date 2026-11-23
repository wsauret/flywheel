import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractNotes,
  RELEASE_EVIDENCE_FILE,
  runReleaseNotes,
  type AcpConnection,
  type AcpRequest,
} from "../../../scripts/release-notes.js"
import {
  createReleaseNotesManifest,
  releaseNotesManifestViolation,
  releaseNotesSha256,
} from "../../../scripts/release-notes-manifest.js"

const SUMMARY = "This release improves chat. It fixes recovery."
const NOTES = "This release improves chat recovery. It keeps your work available.\n\n## Fixed\n\n- Recover chats"
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function success(notes: string): string {
  return JSON.stringify({ status: "success", notes })
}

/** How the fake chat treats one request, keyed by method, or by
 *  `session/set_config_option:<configId>` for a config option. */
interface ChatScript {
  readonly refuse?: string
  readonly exitAt?: string
  readonly stopReason?: string
  /** The session updates that the prompt turn streams before its answer. */
  readonly updates?: readonly object[]
  /** A request that the chat sends to the client during the prompt turn. */
  readonly ask?: boolean
}

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
const toolCall = { sessionUpdate: "tool_call", toolCallId: "t1", title: "git log", kind: "execute", status: "pending" }
const toolCallUpdate = { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }

function finalMessage(text: string): readonly object[] {
  return [chunk("I will read the evidence first."), toolCall, chunk("Now I verify the claims."), toolCallUpdate, chunk(text.slice(0, 10)), chunk(text.slice(10))]
}

function promptText(request: AcpRequest | undefined): string | undefined {
  return request?.method === "session/prompt" ? request.params.prompt[0].text : undefined
}

function fakeChat(script: ChatScript) {
  const requests: AcpRequest[] = []
  const queue: string[] = []
  let ended = false
  let wake: (() => void) | undefined
  const state = { closed: false }
  const reply = (lines: readonly object[]) => {
    queue.push(...lines.map((line) => JSON.stringify(line)))
    wake?.()
  }
  const waitForLine = () => new Promise<void>((resolve) => { wake = resolve })
  function answer(request: AcpRequest): readonly object[] | "exit" {
    const { id, method } = request
    const key = request.method === "session/set_config_option" ? `${method}:${request.params.configId}` : method
    if (key === script.exitAt) return "exit"
    if (key === script.refuse) return [{ jsonrpc: "2.0", id, error: { code: -32602, message: "not available", data: { failure: "api_error" } } }]
    const result = (value: { readonly sessionId?: string; readonly stopReason?: string }) => ({ jsonrpc: "2.0", id, result: value })
    if (method === "session/new") return [result({ sessionId: "s1" })]
    if (method !== "session/prompt") return [result({})]
    const updates = (script.updates ?? finalMessage(success(NOTES))).map((update) => ({
      jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update },
    }))
    const asked = script.ask === true ? [{ jsonrpc: "2.0", id: 99, method: "elicitation/create", params: { sessionId: "s1", message: "Continue?" } }] : []
    return [...asked, ...updates, result({ stopReason: script.stopReason ?? "end_turn" })]
  }
  const connection: AcpConnection = {
    send(request) {
      requests.push(request)
      const lines = answer(request)
      if (lines === "exit") {
        ended = true
        wake?.()
      } else reply(lines)
    },
    lines: (async function* () {
      for (;;) {
        const line = queue.shift()
        if (line !== undefined) yield line
        else if (ended) return
        else await waitForLine()
      }
    })(),
    async close() {
      state.closed = true
      ended = true
      wake?.()
    },
  }
  return { connection, requests, state }
}

function fixture(script: ChatScript = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-notes-test-"))
  temporaryRoots.push(root)
  const sourceRoot = join(root, "source")
  const outFile = join(root, "published", "release-notes.md")
  const chat = fakeChat(script)
  const worktrees: Array<{ path: string; head: string; removed: boolean }> = []
  const opened: Array<{ worktree: string; authProfileId: string; evidence: string }> = []
  const boundaries = {
    resolveAuthProfileId(projectRoot: string) {
      return projectRoot === sourceRoot ? "source-profile" : "other-profile"
    },
    createWorktree(head: string) {
      const path = mkdtempSync(join(root, "worktree-"))
      worktrees.push({ path, head, removed: false })
      return path
    },
    removeWorktree(path: string) {
      rmSync(path, { recursive: true, force: true })
      for (const worktree of worktrees) if (worktree.path === path) worktree.removed = true
    },
    openChat(worktree: string, authProfileId: string) {
      opened.push({ worktree, authProfileId, evidence: readFileSync(join(worktree, RELEASE_EVIDENCE_FILE), "utf8") })
      return chat.connection
    },
  }
  const input = {
    sourceRoot,
    surface: "terminal" as const,
    version: "1.2.3",
    outFile,
    collected: { evidence: "release evidence", head: "abc123", baseTag: "v1.2.2" },
    prompt: "surface prompt",
    methodPrompt: "method prompt",
  }
  return { root, outFile, chat, worktrees, opened, boundaries, input }
}

describe("release-notes extraction", () => {
  test("returns notes with plain, soft-wrapped, or emphasized summary paragraphs", () => {
    for (const summary of [SUMMARY, SUMMARY.replace("chat. It", "chat.\nIt"), SUMMARY.replace("This release", "**This release**")]) {
      const notes = `${summary}\n\n## Fixed\n\n- Keep chat history`
      expect(extractNotes(success(notes))).toEqual({ notes })
    }
  })

  for (const notes of [
    "I cannot write these release notes.",
    "## Fixed\n\n- Recover chats",
    "Release summary.\n\n## Unknown\n\n- Recover chats",
    "Release summary.\n\n## Fixed",
    "Release summary.\n\n## Fixed\n\nI cannot write these release notes.",
    `${NOTES}\n\nI cannot write these release notes.`,
  ]) {
    test(`rejects a success result with invalid notes: ${JSON.stringify(notes)}`, () => {
      expect(extractNotes(success(notes))).toEqual({ error: "the model result is not release notes: expected a summary and nonempty release-note sections" })
    })
  }

  test("fails closed on an empty final message", () => {
    expect(extractNotes("  \n")).toEqual({ error: "the model returned no notes text" })
  })
})

describe("release-notes chat", () => {
  test("runs one pinned turn in a checkout of the head and keeps only the final message", async () => {
    const state = fixture()

    const notes = await runReleaseNotes(state.input, state.boundaries)

    expect(notes).toBe(NOTES)
    expect(readFileSync(state.outFile, "utf8")).toBe(`${NOTES}\n`)
    expect(state.worktrees).toHaveLength(1)
    const worktree = state.worktrees[0]!
    expect(worktree).toMatchObject({ head: "abc123", removed: true })
    expect(existsSync(worktree.path)).toBe(false)
    expect(state.opened).toEqual([{ worktree: worktree.path, authProfileId: "source-profile", evidence: "release evidence" }])
    expect(state.chat.state.closed).toBe(true)

    const requests = state.chat.requests
    expect(requests.map(({ method }) => method)).toEqual([
      "initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt",
    ])
    expect(requests[1]?.params).toEqual({ cwd: worktree.path, mcpServers: [] })
    expect(requests.slice(2, 4).map(({ params }) => params)).toEqual([
      { sessionId: "s1", configId: "model", value: "claude-opus-5.5" },
      { sessionId: "s1", configId: "effort", value: "high" },
    ])
    const task = promptText(requests[4]) ?? ""
    // Surface scope, then method, then the evidence pointer, then the result contract.
    const order = ["surface prompt", "method prompt", join(worktree.path, RELEASE_EVIDENCE_FILE), "v1.2.2", "abc123", '{"status":"success"']
    const positions = order.map((part) => task.indexOf(part))
    expect(positions.every((position, index) => position > (positions[index - 1] ?? -1))).toBe(true)
    // The evidence is a file in the checkout, never part of the prompt.
    expect(task).not.toContain("release evidence")
  })

  test("names the absence of a previous release", async () => {
    const state = fixture()
    await runReleaseNotes({ ...state.input, collected: { ...state.input.collected, baseTag: undefined } }, state.boundaries)
    expect(promptText(state.chat.requests[4])).toContain("There is no previous release")
  })

  for (const failure of [
    { name: "a refused model", script: { refuse: "session/set_config_option:model" }, error: "refused session/set_config_option: not available" },
    { name: "a refused effort", script: { refuse: "session/set_config_option:effort" }, error: "refused session/set_config_option: not available" },
    { name: "a failed turn", script: { refuse: "session/prompt" }, error: "refused session/prompt: not available (api_error)" },
    { name: "a cancelled turn", script: { stopReason: "cancelled" }, error: 'stopped with "cancelled", not end_turn' },
    { name: "a chat that exits before it answers", script: { exitAt: "session/prompt" }, error: "exited before it answered session/prompt" },
    { name: "a chat that asks a question", script: { ask: true }, error: "unexpected elicitation/create during session/prompt" },
    { name: "a tool call after the last message text", script: { updates: [chunk(success(NOTES)), toolCall] }, error: "the model returned no notes text" },
    { name: "a final message that is not JSON", script: { updates: [chunk("I cannot write these release notes.")] }, error: "the model did not return a release-notes JSON result" },
    { name: "a refusal result", script: { updates: [chunk(JSON.stringify({ status: "refused", reason: "too large" }))] }, error: "the model refused to generate release notes" },
    { name: "a success result that is not notes", script: { updates: [chunk(success("I cannot write these release notes."))] }, error: "expected a summary and nonempty release-note sections" },
  ] satisfies ReadonlyArray<{ name: string; script: ChatScript; error: string }>) {
    test(`${failure.name} fails, removes the checkout, and writes neither notes nor a manifest`, async () => {
      const state = fixture(failure.script)

      await expect(runReleaseNotes({ ...state.input, surface: "vscode" }, state.boundaries)).rejects.toThrow(failure.error)

      expect(state.worktrees.map(({ removed }) => removed)).toEqual([true])
      expect(state.chat.state.closed).toBe(true)
      expect(existsSync(state.outFile)).toBe(false)
      expect(existsSync(join(state.root, "published", "release-notes.json"))).toBe(false)
    })
  }

  test("binds the VS Code manifest to the final notes", async () => {
    const state = fixture()

    await runReleaseNotes({ ...state.input, surface: "vscode" }, state.boundaries)

    const manifest = JSON.parse(readFileSync(join(state.root, "published", "release-notes.json"), "utf8"))
    expect(manifest.notesSha256).toBe(releaseNotesSha256(`${NOTES}\n`))
  })
})

describe("release-notes manifest", () => {
  const identity = { surface: "vscode", releaseVersion: "0.0.2", head: "abc123", baseTag: "vscode-v0.0.1" } as const
  const notes = "## Fixed\n\n- One fix\n"

  test("binds notes to every identity field and its exact content", () => {
    const manifest = createReleaseNotesManifest(identity, notes)
    expect(releaseNotesManifestViolation(manifest, identity, notes)).toBeUndefined()
    expect(releaseNotesManifestViolation(manifest, { ...identity, surface: "terminal" }, notes)).toContain("not terminal")
    expect(releaseNotesManifestViolation(manifest, { ...identity, releaseVersion: "0.0.3" }, notes)).toContain("not 0.0.3")
    expect(releaseNotesManifestViolation(manifest, { ...identity, head: "other" }, notes)).toContain("another source commit")
    expect(releaseNotesManifestViolation(manifest, { ...identity, baseTag: "vscode-v0.0.0" }, notes)).toContain("another release boundary")
    expect(releaseNotesManifestViolation(manifest, identity, `${notes}changed`)).toContain("does not match")
  })

  test("represents the initial release boundary as null", () => {
    const initialIdentity = { ...identity, baseTag: undefined }
    const manifest = createReleaseNotesManifest(initialIdentity, notes)
    expect(manifest.baseTag).toBeNull()
    expect(releaseNotesManifestViolation(manifest, initialIdentity, notes)).toBeUndefined()
  })
})
