import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RuntimeUiPatchPayloadSchema, RuntimeUiPatchSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { stringDiscriminatorLiterals } from "../../../../src/protocol/schema-union.js"
import { runtimeUiPatchFixtures } from "../../protocol/runtime-ui-patch-fixtures.js"

describe("runtime UI patch contract", () => {
  test("preserves queued subagent metadata", () => {
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "s1" }, position: 2, prevPosition: 1,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{
        kind: "upsert", index: 0, blockId: "agentGroup:a1",
        block: {
          kind: "agentGroup", containerKind: "subagent", id: "a1", toolUseId: "tool-a1", label: "Implementer",
          description: "Phase 2", agentType: "implementer", status: "queued", children: [], totalToolCount: 0, timestamp: 1,
        },
      }] } },
    } as const
    const decoded: unknown = Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)
    expect(decoded).toEqual(patch)
  })

  test("carries a workflow tree of phases, their agents, and each attempt's operations, and rejects a loaded view without a tree or with a launch", () => {
    const tree = {
      nodes: [
        { id: "items:phase:1", kind: "phase", form: "list", phaseId: "implement", label: "Implement", parentId: null, disposition: "running", list: { id: "items", expanded: true },
          join: { reducer: "collect@1", state: "pending", slots: 2, completed: 0, failed: 1, pending: 1, missing: 0, coverage: { status: "partial", required: { surveyed: 1, total: 2 }, unsurveyed: ["b"] } } },
        { id: "items:item:2:phase:1", kind: "agent", definitionId: "implement", label: "Implement", parentId: "items:phase:1", disposition: "failed", reason: "summary is required", attempts: 1,
          currentAttemptId: "items:item:2:phase:1:attempt:1", item: { nodeId: "items:item:2", key: "b", label: "Item b", ordinal: 2, text: "b" } },
        { id: "votes", kind: "phase", form: "list", phaseId: "checks", label: "checks", parentId: null, disposition: "completed", list: { id: "votes", expanded: true },
          join: { reducer: "quorum@1", state: "settled", slots: 3, completed: 3, failed: 0, pending: 0, missing: 0, selection: { verb: "passed", kept: 2, dropped: 1 } } },
      ],
      currentAgentNodeId: "items:item:1:phase:1",
    } as const
    const patch = {
      cursor: { scope: "workflow", domain: "workflow_view", workflowId: "s1" }, position: 2, prevPosition: 1,
      payload: { kind: "workflow_view.updated", workflowView: {
        attempts: [{ id: "items:item:2:phase:1:attempt:1", definitionId: "implement", briefId: "implement", name: "Implement", status: "completed", startedAt: 1, completedAt: 2, toolUses: 3, history: [] }],
        attemptsStatus: "loaded", state: "running", tree,
      } },
    } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    expect(Schema.encodeSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    const { tree: _tree, ...older } = patch.payload.workflowView
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, payload: { ...patch.payload, workflowView: older } })).toThrow()
    const launched = { ...patch.payload.workflowView, launch: { verification: "proved" } }
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })({ ...patch, payload: { ...patch.payload, workflowView: launched } })).toThrow()
  })

  // A service of protocol 51 still sends `warnings` on a workflow card. The
  // card no longer shows them, and the client reads such a patch as a card
  // without them.
  test("reads a workflow card that an older service sent with launch warnings", () => {
    const patch = {
      cursor: { scope: "session", domain: "output", sessionId: "s1" }, position: 2, prevPosition: 1,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [{
        kind: "upsert", index: 0, blockId: "agentGroup:w1",
        block: {
          kind: "agentGroup", containerKind: "workflow", id: "w1", toolUseId: "tool-w1", label: "review", description: "Review", status: "active",
          children: [], totalToolCount: 0, timestamp: 1, warnings: ["review.workflow.yaml flow[0] map: the list holds at most 100 items"],
        },
      }] } },
    } as const
    const decoded: unknown = Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)
    const { warnings: _warnings, ...card } = patch.payload.delta.blocks[0].block
    expect(decoded).toEqual({ ...patch, payload: { ...patch.payload, delta: { ...patch.payload.delta, blocks: [{ ...patch.payload.delta.blocks[0], block: card }] } } })
  })

  test("carries protocol violation invalidations", () => {
    const patch = {
      cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0,
      payload: { kind: "runtime.invalidate", reason: "protocol_violation" },
    } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  })

  test("has one exact fixture for every canonical direct patch leaf", () => {
    const canonicalKinds = stringDiscriminatorLiterals(RuntimeUiPatchPayloadSchema, "kind")
    const fixtureKinds: readonly string[] = runtimeUiPatchFixtures.map((patch) => patch.payload.kind)
    expect(fixtureKinds.toSorted()).toEqual(canonicalKinds.toSorted())
    expect(new Set(canonicalKinds).size).toBe(canonicalKinds.length)
    for (const patch of runtimeUiPatchFixtures) {
      const decoded: unknown = Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)
      expect(decoded).toEqual(patch)
    }
  })
})
