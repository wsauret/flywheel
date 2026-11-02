import assert from "node:assert/strict"
import { test } from "bun:test"

import type { ProjectFileEntry } from "../../../src/protocol/transcript-protocol-types.js"
import { pickFile, type FileItem, type FileQuickPick } from "./file-picker.js"

/** A quick pick that records what the picker sets and lets the test act as
 *  the person: type, highlight a row, press Enter, or close it. */
function quickPick() {
  const onValue: ((value: string) => void)[] = []
  const onAccept: (() => void)[] = []
  const onHide: (() => void)[] = []
  const listeners = { value: onValue, accept: onAccept, hide: onHide }
  const none: readonly FileItem[] = []
  const pick = {
    title: "", placeholder: "", busy: false, value: "",
    items: none, activeItems: none, selectedItems: none,
    shown: false, disposed: false,
    onDidChangeValue(listener: (value: string) => void) { listeners.value.push(listener); return { dispose() {} } },
    onDidAccept(listener: () => void) { listeners.accept.push(listener); return { dispose() {} } },
    onDidHide(listener: () => void) { listeners.hide.push(listener); return { dispose() {} } },
    show() { pick.shown = true },
    hide() { for (const listener of listeners.hide) listener() },
    dispose() { pick.disposed = true },
    type(value: string) { pick.value = value; for (const listener of listeners.value) listener(value) },
    enter(row: number) { pick.activeItems = [pick.items[row]!]; pick.selectedItems = [pick.items[row]!]; for (const listener of listeners.accept) listener() },
  }
  return pick
}

let current = quickPick()
const create = (): FileQuickPick => current

async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve() }

const PROJECT = new Map<string, readonly ProjectFileEntry[]>([
  ["", [{ path: "docs", directory: true }, { path: "hello.txt", directory: false }]],
  ["docs/", [{ path: "docs/meeting notes.md", directory: false }]],
])

test("lists the runtime's files, walks into a directory, and returns the file as the client's own mention", async () => {
  current = quickPick()
  const queries: string[] = []
  const picked = pickFile(async (query) => { queries.push(query); return PROJECT.get(query) ?? [] }, create)
  await settle()
  assert.ok(current.shown)
  // The runtime already ranked every row for the query, so none may be
  // filtered away a second time.
  assert.deepEqual(current.items.map((item) => [item.label, item.alwaysShow]), [["$(folder) docs/", true], ["$(file) hello.txt", true]])
  current.enter(0)
  await settle()
  assert.equal(current.value, "docs/")
  assert.deepEqual(current.items.map((item) => item.label), ["$(file) docs/meeting notes.md"])
  current.enter(0)
  assert.equal(await picked, '@"docs/meeting notes.md" ')
  assert.ok(queries.includes("docs/"))
  assert.ok(current.disposed)
})

test("shows only the answer to the newest query", async () => {
  current = quickPick()
  const answers = new Map<string, (entries: readonly ProjectFileEntry[]) => void>()
  const picked = pickFile((query) => new Promise((resolve) => { answers.set(query, resolve) }), create)
  current.type("hel")
  answers.get("hel")!([{ path: "hello.txt", directory: false }])
  answers.get("")!([{ path: "docs", directory: true }])
  await settle()
  assert.deepEqual(current.items.map((item) => item.label), ["$(file) hello.txt"])
  current.enter(0)
  assert.equal(await picked, "@hello.txt ")
})

test("resolves nothing when the person closes the picker", async () => {
  current = quickPick()
  const picked = pickFile(async () => [], create)
  current.hide()
  assert.equal(await picked, undefined)
})
