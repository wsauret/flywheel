import { expect, test } from "bun:test"
import { editorClientReplacement } from "./client-replacement.js"
import { createInputReload } from "../src/client/input-reload.js"
import type { CapabilityRequest } from "../../src/protocol/client/editor-host.js"

test("an older host keeps the mounted input, receives no unsupported capability, and shows the upgrade remedy", async () => {
  const requests: CapabilityRequest[] = []
  const notices: string[] = []
  const replacement = editorClientReplacement(async (request) => { requests.push(request) }, 1, 0)
  let captures = 0
  const reload = createInputReload({
    ...replacement, settled: async () => {},
    capture: () => { captures++; return { version: 1, scope: "old-host" } },
    save: async () => { throw new Error("must not save") },
    hold: () => { throw new Error("must not hold input") },
    report: (message) => { notices.push(message) },
  })
  await reload.replace()
  expect(requests).toEqual([])
  expect(captures).toBe(0)
  expect(notices).toEqual(["This Flywheel host is older than the client the runtime serves. Update it to continue. Your unsent input is still here."])
})
