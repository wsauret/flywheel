import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeCommandCatalogResult } from "../../../../src/protocol/command-catalog-protocol-types.js"
import { createCommandCatalog } from "../../../../src/tui/hooks/create-command-catalog.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

test("the catalog is unknown until its first snapshot arrives, and known with that snapshot's roster after", async () => {
  const snapshot = Promise.withResolvers<RuntimeCommandCatalogResult>()
  // The catalog cache issues only the commandCatalog query.
  const query = runtimeQuery({ commandCatalog: () => snapshot.promise })
  const appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> = {
    onLane: fakeLanes().onLane,
    query,
    subscribe: () => () => {},
  }
  await createRoot(async (dispose) => {
    try {
      const catalog = createCommandCatalog({ appService })
      let arrived = false
      void catalog.arrived.then(() => { arrived = true })
      await Promise.resolve()
      expect(catalog.known()).toBe(false)
      expect(arrived).toBe(false)
      snapshot.resolve({
        revision: 3, snapshotPosition: 1, offCommands: [],
        builtInCommands: [{ id: "doctor", title: "Doctor", description: "Check this machine", aliases: [] }],
      })
      await catalog.arrived
      expect(catalog.known()).toBe(true)
      expect(catalog.builtInCommands().map((command) => command.id)).toEqual(["doctor"])
    } finally {
      dispose()
    }
  })
})
