import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { migrateWorkflowDefinitionIdentityContext } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity.js"
import { migrateDefinitionIdentitySkillCatalog } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-skill-catalog.js"
import { DEFINITION_IDENTITY_RENAME_MIGRATION_ID } from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildDefinitionIdentityMigratedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { aggregateFacts, preCutoverIdentity, processDirectories, recordedPositionIds, seedLegacyAggregate, WORKFLOW_ID } from "./_legacy-workflow-aggregate.js"
import { RETIRED_BINDING_IDS, RETIRED_SKILL_IDS, RETIRED_WORKFLOW_ID, seedPreRenameAggregate } from "./_pre-rename-workflow-aggregate.js"

const temporary = temporaryDirectories()
const makeDbFile = () => join(temporary("flywheel-rename-identity-"), "flywheel.sqlite")
const replay = (dbFile: string, sessionId: string) => replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId(sessionId)))

/** A run recorded before the workflow rename keeps the ids it recorded. No
 *  migration adopts current names for it: named workflows no longer load, so
 *  the history reader alone must read it. */
describe("pre-rename workflow history", () => {
  it("reads the recorded identity and every companion id of a paused named run", async () => {
    const dbFile = makeDbFile()
    const sessionId = "paused-session"
    const staged = seedPreRenameAggregate(dbFile, sessionId, { companions: true, authoredFollowUp: true, controlHistory: true, sessionMetadata: true })
    if (!staged) throw new Error("Test fixture needs a driven control history")

    expect(replay(dbFile, sessionId).definitionIdentity.workflowDefinitionId).toBe(RETIRED_WORKFLOW_ID)
    expect(replay(dbFile, sessionId).attempts).toEqual(staged.attempts)
    expect(replay(dbFile, sessionId).frontier).toEqual(staged.frontier)
    expect(recordedPositionIds(dbFile, sessionId)).toEqual([...RETIRED_BINDING_IDS].sort())
    const store = createSqliteEventStore(dbFile)
    try {
      const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), sessionId)
      expect(queue?.attempts.map(({ briefId }) => briefId)).toEqual([...RETIRED_SKILL_IDS])
      expect(new Set(queue?.attempts.map(({ workflowDefinitionId }) => workflowDefinitionId))).toEqual(new Set([RETIRED_WORKFLOW_ID]))
    } finally {
      store.close()
    }
  })

  it("holds a released v1 rename adoption as the identity of the run", () => {
    const dbFile = makeDbFile()
    const sessionId = "prior-namespace"
    seedPreRenameAggregate(dbFile, sessionId)
    const current = preCutoverIdentity(WORKFLOW_ID)
    const v1Identity = { ...current, skills: current.skills.map((skill) => skill.skillId === "fly.implementation-spec" ? { ...skill, skillId: "implementation-spec" } : skill) }
    const fact = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_RENAME_MIGRATION_ID, replay(dbFile, sessionId).definitionIdentity, v1Identity)
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({ ...fact, aggregateId: workflowAggregateId(sessionId), sessionId, timestamp: 2 })
    } finally {
      store.close()
    }
    expect(replay(dbFile, sessionId).definitionIdentity).toEqual(v1Identity)
  })

  it.each(["old-vm", "uninstalled", "lost-binding"] as const)("reads %s history", (kind) => {
    const dbFile = makeDbFile()
    seedPreRenameAggregate(dbFile, kind, {
      companions: true,
      sessionMetadata: true,
      rewriteIdentity: (identity) => kind === "old-vm" ? { ...identity, vmVersion: "1" }
        : kind === "uninstalled" ? { ...identity, workflowDefinitionId: "flywheel-full" }
          : { ...identity, bindings: [...identity.bindings, { bindingId: "plan-verify", sha256: "0".repeat(64) }] },
    })
    expect(() => replay(dbFile, kind)).not.toThrow()
  })

  it("keeps the recorded workflow id after context repair zeroes the recorded skills", () => {
    const dbFile = makeDbFile()
    seedPreRenameAggregate(dbFile, "oldest-session", { omitContextMembers: true })
    migrateWorkflowDefinitionIdentityContext(dbFile, processDirectories)
    expect(replay(dbFile, "oldest-session").definitionIdentity.workflowDefinitionId).toBe(RETIRED_WORKFLOW_ID)
  })

  it("reads pre-catalog and pre-rename runs after the catalog representation pass", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "pre-catalog")
    seedPreRenameAggregate(dbFile, "pre-rename")
    migrateDefinitionIdentitySkillCatalog(dbFile, processDirectories)
    expect(() => replay(dbFile, "pre-catalog")).not.toThrow()
    expect(replay(dbFile, "pre-rename").definitionIdentity.workflowDefinitionId).toBe(RETIRED_WORKFLOW_ID)
  })
})
