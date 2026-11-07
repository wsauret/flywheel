import { describe, expect, test } from "bun:test"

import { extractNotes } from "../../../scripts/release-notes.js"
import { createReleaseNotesManifest, releaseNotesManifestViolation } from "../../../scripts/release-notes-manifest.js"

const SUMMARY = JSON.stringify({ completed: true, termination: { version: 1, terminal: { kind: "completed" } } })

describe("release-notes extraction", () => {
  test("returns the notes body before a completed summary line", () => {
    const result = extractNotes(`## Added\n\n- one\n- two\n${SUMMARY}\n`)
    expect(result).toEqual({ notes: "## Added\n\n- one\n- two" })
  })

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
