import { afterEach, beforeEach, expect, test } from "bun:test"

import { browserInputReloadStorage } from "../src/client/input/input-reload-storage.js"
import { inputScopeOf, movePhoneSelectionState } from "./selection-state.js"

/** The part of IndexedDB, sessionStorage, and localStorage the phone's state
 *  uses, with a browser's order: the requests of a transaction succeed in
 *  the order they were made, then the transaction completes. */
class FakeRequest extends EventTarget {
  result: unknown
}

function browserStorage(records: Map<string, unknown>, values: Map<string, string>) {
  const database = {
    close() {},
    transaction() {
      const transaction = new EventTarget()
      let last = Promise.resolve()
      const request = (answer: (made: FakeRequest) => void) => {
        const made = new FakeRequest()
        last = last.then(() => { answer(made); made.dispatchEvent(new Event("success")) })
        const settled = last
        setTimeout(() => { void settled.then(() => { if (settled === last) transaction.dispatchEvent(new Event("complete")) }) }, 0)
        return made
      }
      return Object.assign(transaction, {
        objectStore: () => ({
          get: (key: string) => request((made) => { made.result = records.get(key) }),
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: IndexedDB stores any structured-clone value
          put: (value: unknown, key: string) => request(() => { records.set(key, value) }),
          delete: (key: string) => request(() => { records.delete(key) }),
        }),
      })
    },
  }
  return {
    indexedDB: { open: () => { const made = Object.assign(new FakeRequest(), { result: database }); setTimeout(() => made.dispatchEvent(new Event("success")), 0); return made } },
    sessionStorage: { getItem: () => "tab", setItem() {} },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
  }
}

const names = ["indexedDB", "sessionStorage", "localStorage"] as const
let before: (readonly [typeof names[number], PropertyDescriptor | undefined])[] = []
const records = new Map<string, unknown>()
const values = new Map<string, string>()

beforeEach(() => {
  records.clear()
  values.clear()
  before = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const fake = browserStorage(records, values)
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: fake[name] })
})

afterEach(() => {
  for (const [name, descriptor] of before) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test("a project's queued input and notifications dismissal saved under an earlier id read under its current id, and never replace state kept there", async () => {
  const earlier = { runtimeId: "machine", placementId: "earlier" }
  const current = { runtimeId: "machine", placementId: "current" }
  const dismissal = (selection: typeof earlier) => `flywheel.push-guide.dismissed:${JSON.stringify([selection.runtimeId, selection.placementId])}`
  const checkpoint = (text: string) => ({ version: 1, scope: inputScopeOf(earlier), composer: { active: { text, attachments: [] }, drafts: {}, questions: {} } })
  records.set(`tab\u0000${inputScopeOf(earlier)}`, checkpoint("queued"))
  values.set(dismissal(earlier), "2000")
  await movePhoneSelectionState(earlier, current)
  expect((await browserInputReloadStorage(inputScopeOf(current)).load())?.composer?.active.text).toBe("queued")
  expect(values.get(dismissal(current))).toBe("2000")
  expect(records.has(`tab\u0000${inputScopeOf(earlier)}`)).toBe(false)
  expect(values.has(dismissal(earlier))).toBe(false)

  records.set(`tab\u0000${inputScopeOf(earlier)}`, checkpoint("older"))
  values.set(dismissal(earlier), "1000")
  await movePhoneSelectionState(earlier, current)
  expect((await browserInputReloadStorage(inputScopeOf(current)).load())?.composer?.active.text).toBe("queued")
  expect(values.get(dismissal(current))).toBe("2000")
})
