import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { MODULE_IDS } from "../../src/protocol/module-ids.js"
import { createModuleContextPublisher, moduleContext } from "./module-context.js"

const manifest: { contributes: { menus: { commandPalette: readonly { readonly command: string; readonly when: string }[] } } } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const palette = new Map(manifest.contributes.menus.commandPalette.map((entry) => [entry.command, entry.when]))

describe("the palette commands a module owns", () => {
  test("show only while their module is on, and while the modules are not known yet", () => {
    for (const [command, id] of [
      ["flywheel.learn", "learning"],
      ["flywheel.drainPapercuts", "papercuts"],
      ["flywheel.showUsage", "subscription-usage"],
      ["flywheel.interruptWorkflow", "workflows"],
    ] as const) {
      assert.equal(palette.get(command), `!flywheel.modulesKnown || flywheel.module.${id}`, command)
    }
  })

  test("name only modules the runtime has", () => {
    const known: ReadonlySet<string> = new Set(MODULE_IDS)
    for (const when of palette.values()) {
      for (const [, id] of when.matchAll(/flywheel\.module\.([a-z-]+)/g)) assert.ok(id !== undefined && known.has(id), id)
    }
  })

  test("read every module as off except the enabled ones once the client names them", () => {
    const context = new Map(moduleContext(["learning"]))
    assert.equal(context.get("flywheel.modulesKnown"), true)
    assert.equal(context.get("flywheel.module.learning"), true)
    assert.equal(context.get("flywheel.module.workflows"), false)
    assert.equal(new Map(moduleContext(undefined)).get("flywheel.modulesKnown"), false)
  })

  test("are set again only when the enabled modules change", () => {
    const writes: string[] = []
    const publish = createModuleContextPublisher((key, value) => { if (key === "flywheel.module.workflows") writes.push(String(value)) })
    publish(["workflows", "learning"])
    publish(["learning", "workflows"])
    publish(["learning"])
    assert.deepEqual(writes, ["true", "false"])
  })
})
