import { describe, expect, test } from "bun:test"
import type { SessionCatalogRow } from "../src/protocol/app-service-types.js"
import { createProjectControlClient } from "../src/orchestration/app-service/project-control-client.js"
import { projectSessionCatalogRow } from "../src/orchestration/session/session-catalog-row.js"
import type { DurableSessionCatalogRow } from "../src/orchestration/session/session-catalog-types.js"
import { durableRow } from "../tests/unit/orchestration/app-service/_frontend-projection-fixtures.js"
import { fixture } from "../tests/unit/orchestration/app-service/_project-control-client-fixture.js"

function listedRow(metadata: DurableSessionCatalogRow): SessionCatalogRow {
  const row = projectSessionCatalogRow(metadata)
  if (row.kind === "subagent") throw new Error(`fixture ${metadata.id} is a child, which has no catalog row`)
  return row
}

describe("session list after a failed first history read", () => {
  test("a change heard after the failure reads the history again and keeps the changes heard meanwhile", async () => {
    const f = fixture()
    f.metadata.set("one", durableRow("one", { label: "One" }))
    const deadline = new Error("history deadline")
    let baselines = 0
    const heard = Promise.withResolvers<void>()
    const client = createProjectControlClient({
      ...f.options,
      history: {
        ...f.options.history,
        async snapshot() {
          if (++baselines === 1) throw deadline
          return { rows: [listedRow(durableRow("one", { label: "One" }))], errors: [], totalsLoading: true }
        },
      },
      state: { ...f.options.state, sessions: { ...f.options.state.sessions, async listForIds(ids) {
        if (ids.includes("three")) heard.resolve()
        return f.options.state.sessions.listForIds(ids)
      } } },
    })
    try {
      f.metadata.set("one", durableRow("one", { label: "Renamed" }))
      f.metadata.set("two", durableRow("two", { label: "Two" }))
      f.notify({ kind: "changed", sessionIds: ["one", "two"] })
      // The failed read may answer this request with an error or with no rows.
      await client.query({ type: "snapshot" }).catch(() => undefined)
      expect(f.failures).toContain(deadline)

      // A change heard after the failure reads the history again, then applies
      // every change still queued.
      f.metadata.set("three", durableRow("three", { label: "Three" }))
      f.notify({ kind: "changed", sessionIds: ["three"] })
      await heard.promise
      const snapshot = await client.query({ type: "snapshot" })
      expect(baselines).toBe(2)
      expect(snapshot.rows.map((row) => [row.id, row.title])).toEqual([["one", "Renamed"], ["two", "Two"], ["three", "Three"]])
    } finally {
      await client.close()
    }
  })

  test("the next snapshot request after the failure reads the history again", async () => {
    const f = fixture()
    f.metadata.set("one", durableRow("one", { label: "One" }))
    f.metadata.set("two", durableRow("two", { label: "Two" }))
    const deadline = new Error("history deadline")
    let baselines = 0
    const client = createProjectControlClient({
      ...f.options,
      history: {
        ...f.options.history,
        async snapshot() {
          if (++baselines === 1) throw deadline
          return { rows: [listedRow(durableRow("one", { label: "One" })), listedRow(durableRow("two", { label: "Two" }))], errors: [], totalsLoading: true }
        },
      },
    })
    try {
      // The failed read may answer this request with an error or with no rows.
      await client.query({ type: "snapshot" }).catch(() => undefined)
      const snapshot = await client.query({ type: "snapshot" })
      expect(baselines).toBe(2)
      expect(snapshot.rows.map((row) => [row.id, row.title])).toEqual([["one", "One"], ["two", "Two"]])
      // A good baseline is not read again by later requests.
      await client.query({ type: "snapshot" })
      expect(baselines).toBe(2)
    } finally {
      await client.close()
    }
  })
})
