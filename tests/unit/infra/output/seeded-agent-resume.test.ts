import { describe, expect, it } from "bun:test"
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js"
import { OutputProjector } from "../../../../src/infra/output/output-projector.js"

/** A parent re-opened from durable history seeds its transcript, so a child's
 *  card arrives as a block, not as a live tool use. A resume then re-dispatches
 *  the child under the original tool use id, and its completion settles the
 *  same card. Both must find the seeded block. */
function seededCard(status: "paused" | "interrupted" | "active"): AgentGroupBlock {
  const base = {
    kind: "agentGroup" as const,
    containerKind: "subagent" as const,
    id: "dispatch-1",
    toolUseId: "dispatch-1",
    label: "Explorer",
    description: "Fixture child",
    children: [],
    totalToolCount: 0,
    timestamp: 1_000,
    duration: 500,
  }
  return status === "paused" ? { ...base, status, pausedBy: "person" } : { ...base, status }
}

function card(projector: OutputProjector): AgentGroupBlock {
  const block = projector.getBlocks()[0]
  if (block?.kind !== "agentGroup") throw new Error("expected the seeded agent card")
  return block
}

describe("a seeded child card across resume", () => {
  for (const status of ["paused", "interrupted"] as const) {
    it(`re-dispatches a seeded ${status} card as active and completes it from the dispatch tool's result`, () => {
      const projector = new OutputProjector({ executionCwd: "/scratch/seeded-agent-resume", sessionId: "parent" })
      projector.seedBlocks([seededCard(status)])

      projector.apply({ type: "agent-dispatched", toolUseId: "dispatch-1", timestamp: 2_000 })
      expect(card(projector)).toMatchObject({ status: "active", description: "Fixture child" })
      expect("pausedBy" in card(projector)).toBe(false)

      projector.apply({ type: "tool-result", toolUseId: "dispatch-1", outcome: "ok", timestamp: 3_000 })
      expect(card(projector)).toMatchObject({ status: "completed" })
    })
  }

  it("a second client's seed over a running child keeps the card active and a pause still reaches it", () => {
    // The parent runner is live and its child is running when another client
    // opens the parent: activation reseeds the durable fold over the live
    // blocks. The fold reads the created run as active, and the later pause
    // event routes to the same card.
    const projector = new OutputProjector({ executionCwd: "/scratch/seeded-agent-resume", sessionId: "parent" })
    projector.apply({ type: "tool-use", toolUseId: "dispatch-1", name: "subagent", input: { persona: "explorer", description: "Fixture child" }, timestamp: 1_000 })
    projector.apply({ type: "agent-dispatched", toolUseId: "dispatch-1", timestamp: 1_100 })
    expect(card(projector)).toMatchObject({ status: "active" })

    projector.seedBlocks([{ ...seededCard("active"), id: card(projector).id }])
    expect(card(projector)).toMatchObject({ status: "active", description: "Fixture child" })

    projector.apply({ type: "agent-paused", toolUseId: "dispatch-1", timestamp: 2_000, pausedBy: "person" })
    expect(card(projector)).toMatchObject({ status: "paused", pausedBy: "person" })
  })

  it("a seeded active card on a fresh runner takes the child's pause and completion", () => {
    const projector = new OutputProjector({ executionCwd: "/scratch/seeded-agent-resume", sessionId: "parent" })
    projector.seedBlocks([seededCard("active")])

    projector.apply({ type: "agent-paused", toolUseId: "dispatch-1", timestamp: 2_000, pausedBy: "runtime" })
    expect(card(projector)).toMatchObject({ status: "paused", pausedBy: "runtime" })

    projector.apply({ type: "agent-dispatched", toolUseId: "dispatch-1", timestamp: 3_000 })
    projector.apply({ type: "tool-result", toolUseId: "dispatch-1", outcome: "ok", timestamp: 4_000 })
    expect(card(projector)).toMatchObject({ status: "completed" })
  })

  it("leaves a settled seeded card alone", () => {
    const projector = new OutputProjector({ executionCwd: "/scratch/seeded-agent-resume", sessionId: "parent" })
    projector.seedBlocks([{ ...seededCard("interrupted"), status: "completed" }])

    projector.apply({ type: "agent-dispatched", toolUseId: "dispatch-1", timestamp: 2_000 })
    expect(card(projector)).toMatchObject({ status: "completed" })
  })
})
