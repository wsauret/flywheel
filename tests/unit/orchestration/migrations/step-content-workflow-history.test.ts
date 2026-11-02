import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { isLegacyDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { compiledControl, processRoot } from "./_legacy-workflow-aggregate.js"
import { prePhaseRoot } from "./_pre-phase-control.js"

const temporary = temporaryDirectories()

describe("step-content workflow history", () => {
  it("replays paused named runs with the legacy identities they recorded", () => {
    const dbFile = join(temporary("flywheel-step-content-identity-"), "flywheel.sqlite")
    const store = createSqliteEventStore(dbFile)
    try {
      for (const workflowId of ["implement", "debug", "qa"]) {
        const control = { ...compiledControl(processRoot, workflowId), status: "paused" as const, aggregateSeq: 0 }
        const root = prePhaseRoot(control)
        store.append({ aggregateId: workflowAggregateId(workflowId), sessionId: workflowId, type: root.type, version: root.version, timestamp: 1, actor: "flywheel", payload: root.payload })
        const identity = replayWorkflowControl(store.readTolerant({ aggregateId: workflowAggregateId(workflowId) })).definitionIdentity
        expect(isLegacyDefinitionIdentity(identity)).toBe(true)
        expect(identity).toEqual(control.definitionIdentity)
      }
    } finally {
      store.close()
    }
  })
})
