import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  extractNotes,
  releaseNotesHeadlessArgs,
  RELEASE_EVIDENCE_FILE,
  runReleaseNotes,
  type ReleaseNotesInvocation,
} from "../../../scripts/release-notes.js"
import {
  createReleaseNotesManifest,
  releaseNotesManifestViolation,
  releaseNotesSha256,
} from "../../../scripts/release-notes-manifest.js"

const SUMMARY = JSON.stringify({ completed: true, termination: { version: 1, terminal: { kind: "completed" } } })
const DRAFT = "This release improves chat. It fixes recovery.\n\n## Added\n\n- Resume chats"
const NOTES = "This release improves chat recovery. It keeps your work available.\n\n## Fixed\n\n- Recover chats"
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function completed(notes: string): ReleaseNotesInvocation {
  return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify({ status: "success", notes })}\n${SUMMARY}\n`) }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-notes-test-"))
  temporaryRoots.push(root)
  const sourceRoot = join(root, "source")
  const outFile = join(root, "published", "release-notes.md")
  const scratchRoots: string[] = []
  const calls: Array<{ scratchRoot: string; authProfileId: string; task: string; evidence: string }> = []
  const responses: ReleaseNotesInvocation[] = []
  const boundaries = {
    resolveAuthProfileId(projectRoot: string) {
      expect(projectRoot).toBe(sourceRoot)
      return projectRoot === sourceRoot ? "source-profile" : "sticky-profile"
    },
    createScratchProject() {
      const scratchRoot = mkdtempSync(join(root, "scratch-"))
      scratchRoots.push(scratchRoot)
      return scratchRoot
    },
    invoke(scratchRoot: string, authProfileId: string, task: string) {
      calls.push({ scratchRoot, authProfileId, task, evidence: readFileSync(join(scratchRoot, RELEASE_EVIDENCE_FILE), "utf8") })
      const response = responses.shift()
      if (response === undefined) throw new Error("missing invocation response")
      return response
    },
  }
  const input = {
    sourceRoot,
    surface: "terminal" as const,
    version: "1.2.3",
    outFile,
    collected: { evidence: "release evidence", head: "abc123", baseTag: "v1.2.2" },
    prompt: "draft prompt",
    reconciliationPrompt: "reconciliation prompt",
  }
  return { root, sourceRoot, outFile, scratchRoots, calls, responses, boundaries, input }
}

describe("release-notes extraction", () => {
  test("returns notes with plain, soft-wrapped, or emphasized summary paragraphs before a completed summary line", () => {
    for (const draft of [
      DRAFT,
      DRAFT.replace("chat. It", "chat.\nIt"),
      DRAFT.replace("This release", "**This release**"),
    ]) {
      const notes = `${draft}\n\n## Fixed\n\n- Keep chat history`
      expect(extractNotes(completed(notes).stdout.toString())).toEqual({ notes })
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
      expect(extractNotes(completed(notes).stdout.toString())).toEqual({ error: "the model result is not release notes: expected a summary and nonempty release-note sections" })
    })
  }

  test("fails closed when the trailing line is not JSON", () => {
    expect(extractNotes("notes\nnot-json")).toEqual({ error: "the invocation output does not end with the JSON summary line" })
  })

  test("fails closed when the trailing JSON is not the task summary", () => {
    expect(extractNotes(`notes\n{"other":true}`)).toEqual({ error: "the trailing JSON line is not the headless task summary" })
  })

  test("fails closed when the task did not complete", () => {
    const summary = JSON.stringify({ termination: { terminal: { kind: "api_error" } } })
    expect(extractNotes(`notes\n${summary}`)).toEqual({ error: 'the headless task terminated as "api_error", not completed' })
  })

  test("fails closed when the summary line is the whole output", () => {
    expect(extractNotes(`${SUMMARY}\n`)).toEqual({ error: "the model returned no notes text" })
  })
})

describe("release-notes headless invocation", () => {
  test("uses the mid tier while retaining the source project's auth profile and isolated storage", () => {
    expect(releaseNotesHeadlessArgs("/scratch/project", "Personal", "write notes")).toEqual([
      "--project-root", "/scratch/project",
      "--auth-profile", "Personal",
      "--headless",
      "--task", "write notes",
      "--model", "mid",
      "--effort", "medium",
      "--deadline-seconds", "900",
    ])
  })

  test("drafts and reconciles in one scratch project with the source profile", async () => {
    const state = fixture()
    state.responses.push(completed(DRAFT), completed(NOTES))

    const notes = await runReleaseNotes(state.input, state.boundaries)

    expect(notes).toBe(NOTES)
    expect(state.calls).toHaveLength(2)
    expect(state.calls.map(({ authProfileId }) => authProfileId)).toEqual(["source-profile", "source-profile"])
    expect(state.calls.map(({ scratchRoot }) => scratchRoot).every((root) => root === state.scratchRoots[0])).toBe(true)
    expect(state.calls[1]?.task).toContain("reconciliation prompt")
    expect(state.calls[1]?.task).toContain(DRAFT)
    // Both calls read the evidence from the project, so no task carries it.
    expect(state.calls.map(({ scratchRoot, task, evidence }) => ({ named: task.includes(join(scratchRoot, RELEASE_EVIDENCE_FILE)), carried: task.includes("release evidence"), evidence }))).toEqual([
      { named: true, carried: false, evidence: "release evidence" },
      { named: true, carried: false, evidence: "release evidence" },
    ])
    expect(readFileSync(state.outFile, "utf8")).toBe(`${NOTES}\n`)
    expect(existsSync(state.scratchRoots[0]!)).toBe(false)
  })

  for (const failure of [
    { name: "draft nonzero", responses: [{ exitCode: 7, stdout: Buffer.from("") }] },
    {
      name: "draft non-completed",
      responses: [{ exitCode: 0, stdout: Buffer.from('notes\n{"termination":{"terminal":{"kind":"api_error"}}}\n') }],
    },
    { name: "reconciliation nonzero", responses: [completed(DRAFT), { exitCode: 9, stdout: Buffer.from("") }] },
    {
      name: "reconciliation non-completed",
      responses: [completed(DRAFT), { exitCode: 0, stdout: Buffer.from('notes\n{"termination":{"terminal":{"kind":"api_error"}}}\n') }],
    },
  ] satisfies ReadonlyArray<{ name: string; responses: ReleaseNotesInvocation[] }>) {
    test(`${failure.name} cleans scratch and does not publish`, async () => {
      const state = fixture()
      state.responses.push(...failure.responses)

      await expect(runReleaseNotes(state.input, state.boundaries)).rejects.toThrow()

      expect(existsSync(state.scratchRoots[0]!)).toBe(false)
      expect(existsSync(state.outFile)).toBe(false)
    })
  }

  for (const stage of ["draft", "reconciliation"] as const) {
    for (const refusal of [
      { text: "I cannot write these release notes.", error: "the model did not return a release-notes JSON result" },
      { text: JSON.stringify({ status: "refused", reason: "I cannot write these release notes." }), error: "the model refused to generate release notes" },
      { text: JSON.stringify({ status: "success", notes: "I cannot write these release notes." }), error: "expected a summary and nonempty release-note sections" },
    ]) {
      test(`${stage} refusal ${refusal.text} writes neither notes nor a manifest`, async () => {
        const state = fixture()
        if (stage === "reconciliation") state.responses.push(completed(DRAFT))
        state.responses.push({ exitCode: 0, stdout: Buffer.from(`${refusal.text}\n${SUMMARY}\n`) })

        await expect(runReleaseNotes({ ...state.input, surface: "vscode" }, state.boundaries)).rejects.toThrow(refusal.error)

        expect(existsSync(state.scratchRoots[0]!)).toBe(false)
        expect(existsSync(state.outFile)).toBe(false)
        expect(existsSync(join(state.root, "published", "release-notes.json"))).toBe(false)
        expect(state.calls).toHaveLength(stage === "draft" ? 1 : 2)
      })
    }
  }

  test("binds the VS Code manifest to reconciled text", async () => {
    const state = fixture()
    state.responses.push(completed(DRAFT), completed(NOTES))
    const input = { ...state.input, surface: "vscode" as const }

    await runReleaseNotes(input, state.boundaries)

    const manifest = JSON.parse(readFileSync(join(state.root, "published", "release-notes.json"), "utf8"))
    expect(manifest.notesSha256).toBe(releaseNotesSha256(`${NOTES}\n`))
    expect(manifest.notesSha256).not.toBe(releaseNotesSha256(`${DRAFT}\n`))
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
