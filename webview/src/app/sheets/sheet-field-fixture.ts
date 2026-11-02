import { createComponent, createRoot } from "solid-js"

import { createElement, insert, nodes } from "../render-ownership-host-fixture.js"
import { SheetField } from "./controls.js"

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Mounts one SheetField whose props record every read made once its
 *  teardown starts, so a test can see whether disposal reads parent state. */
export function mountSheetField() {
  return createRoot((dispose) => {
    const root = createElement("root")
    const commits: string[] = []
    const reports: string[] = []
    const teardownReads: string[] = []
    let tearingDown = false
    const read = <T>(name: string, value: T): T => {
      if (tearingDown) teardownReads.push(name)
      return value
    }
    Reflect.set(globalThis, "__flywheelSheetFieldTestClient", {
      report: (_severity: "info" | "warning", message: string) => { reports.push(message) },
    })
    insert(root, createComponent(SheetField, {
      get label() { return read("label", "Name") },
      get value() { return read("value", "Old") },
      get working() { return read("working", false) },
      get validate() { return read("validate", (draft: string) => draft.trim() === "" ? "Enter a name." : undefined) },
      get onCommit() { return read("onCommit", (draft: string) => { commits.push(draft) }) },
    }))
    const find = (matches: (label: string) => boolean) => {
      const found = nodes(root).find((node) => matches(String(node.properties["aria-label"])))
      if (!found) throw new Error("Missing the field control")
      return found
    }
    return {
      ready: tick,
      open() {
        const open = find((label) => label.startsWith("Name:")).properties.onClick
        if (typeof open === "function") open()
      },
      type(value: string) {
        const input = find((label) => label === "Name").properties.onInput
        if (typeof input === "function") input({ currentTarget: { value } })
      },
      dispose() {
        tearingDown = true
        dispose()
        Reflect.deleteProperty(globalThis, "__flywheelSheetFieldTestClient")
      },
      commits,
      reports,
      teardownReads,
    }
  })
}
