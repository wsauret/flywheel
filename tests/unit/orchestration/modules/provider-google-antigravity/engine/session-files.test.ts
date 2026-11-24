import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createProcessRecord, sweepLogin } from "../../../../../../src/orchestration/modules/provider-google-antigravity/engine/session-files.js"
import { temporaryDirectories } from "../../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

const S1 = "11111111-1111-4111-8111-111111111111"
const S2 = "22222222-2222-4222-8222-222222222222"
const S3 = "33333333-3333-4333-8333-333333333333"

/** Writes the files that agy 1.5.14 leaves for the session `id` in the login's home. */
function sessionFiles(loginDir: string, id: string) {
  const data = join(loginDir, "home", ".gemini", "antigravity-cli")
  for (const suffix of [".db", ".db-wal", ".db-shm"]) writeInto(join(data, "conversations", `${id}${suffix}`))
  writeInto(join(data, "annotations", `${id}.pbtxt`))
  writeInto(join(data, "brain", id, ".system_generated", "logs", "transcript_full.jsonl"))
}

function writeInto(path: string, text = "x") {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

/** The sessions that have any file in the login's home, and the shared files that every session keeps. */
function onDisk(loginDir: string) {
  const data = join(loginDir, "home", ".gemini", "antigravity-cli")
  const names = (folder: string) => existsSync(join(data, folder)) ? readdirSync(join(data, folder)) : []
  return {
    sessions: [...new Set([...names("conversations"), ...names("annotations"), ...names("brain")].map((name) => name.replace(/\..*$/u, "")))].toSorted(),
    shared: ["builtin/keep.txt", "conversation_summaries.db", "antigravity-oauth-token", "settings.json"].filter((name) => existsSync(join(data, name))),
  }
}

function sharedFiles(loginDir: string) {
  const data = join(loginDir, "home", ".gemini", "antigravity-cli")
  for (const name of ["builtin/keep.txt", "conversation_summaries.db", "antigravity-oauth-token", "settings.json"]) writeInto(join(data, name))
}

/** A record whose owner is proven gone: it names this test's pid with another start stamp, which the kernel never
 *  gives this process. */
function goneRecord(loginDir: string, processId: string, fields: { readonly pendingOpens: number; readonly sessions: readonly string[] }) {
  writeInto(join(loginDir, "processes", `${processId}.json`), JSON.stringify({ pid: process.pid, v: 1, start: "1", ...fields }))
}

describe("the session files of a login", () => {
  test("a closed process removes the files of every session it opened and its record, and nothing else", () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-files-")
    sharedFiles(loginDir)
    const record = createProcessRecord(loginDir, "p1")
    record.beginOpen()
    sessionFiles(loginDir, S1)
    record.endOpen(S1)
    sessionFiles(loginDir, S2)
    record.remove()
    expect(onDisk(loginDir)).toEqual({ sessions: [S2], shared: ["builtin/keep.txt", "conversation_summaries.db", "antigravity-oauth-token", "settings.json"] })
    expect(readdirSync(join(loginDir, "processes"))).toEqual([])
  })

  test("a sweep removes a gone owner's sessions and the sessions that no live owner names, and keeps a live owner's", () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-files-")
    sharedFiles(loginDir)
    const live = createProcessRecord(loginDir, "live")
    live.beginOpen()
    live.endOpen(S1)
    goneRecord(loginDir, "gone", { pendingOpens: 0, sessions: [S2] })
    for (const id of [S1, S2, S3]) sessionFiles(loginDir, id)

    expect(sweepLogin(loginDir)).toEqual({ kind: "swept", removedRecords: 1, removedSessions: 2, deferred: false })

    expect(onDisk(loginDir).sessions).toEqual([S1])
    expect(onDisk(loginDir).shared).toHaveLength(4)
    expect(readdirSync(join(loginDir, "processes"))).toEqual(["live.json"])
    live.remove()
  })

  test("a launch interrupted while session/new was open leaves files that the sweep removes only once no live owner has an open session/new", () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-files-")
    // The owner ended after it sent session/new and before agy answered: its new session has files that no record names.
    goneRecord(loginDir, "interrupted", { pendingOpens: 1, sessions: [] })
    sessionFiles(loginDir, S3)
    const sibling = createProcessRecord(loginDir, "sibling")
    sibling.beginOpen()
    sessionFiles(loginDir, S1)

    expect(sweepLogin(loginDir)).toEqual({ kind: "swept", removedRecords: 1, removedSessions: 0, deferred: true })
    expect(onDisk(loginDir).sessions).toEqual([S1, S3])

    sibling.endOpen(S1)
    expect(sweepLogin(loginDir)).toEqual({ kind: "swept", removedRecords: 0, removedSessions: 1, deferred: false })
    expect(onDisk(loginDir).sessions).toEqual([S1])
    sibling.remove()
  })

  test("a live owner of another Flywheel process, or a record of an unknown shape, refuses the sweep before it changes anything", () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-files-")
    // The test runner that started this process is alive and is not this process. It can open a session at any time,
    // also one whose files no record names yet (S2), so nothing of the login may go.
    writeInto(join(loginDir, "processes", "other.json"), JSON.stringify({ pid: process.ppid, pendingOpens: 0, sessions: [S1] }))
    goneRecord(loginDir, "gone", { pendingOpens: 0, sessions: [S3] })
    for (const id of [S1, S2, S3]) sessionFiles(loginDir, id)

    expect(sweepLogin(loginDir)).toEqual({ kind: "in-use", otherOwners: 1 })
    expect(onDisk(loginDir).sessions).toEqual([S1, S2, S3])
    expect(readdirSync(join(loginDir, "processes")).toSorted()).toEqual(["gone.json", "other.json"])

    rmSync(join(loginDir, "processes", "other.json"))
    writeInto(join(loginDir, "processes", "future.json"), JSON.stringify({ owner: "a later build", sessions: { S2: true } }))
    expect(sweepLogin(loginDir)).toEqual({ kind: "in-use", otherOwners: 1 })
    expect(onDisk(loginDir).sessions).toEqual([S1, S2, S3])
  })
})
