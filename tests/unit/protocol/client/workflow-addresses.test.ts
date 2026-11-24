import { describe, expect, it } from "bun:test"
import { workflowAgentAddress } from "../../../../src/protocol/client/workflow-addresses.js"
import { workflowAgentModel } from "../../../../src/protocol/client/workflow-agent.js"
import { fourLaneControl, frontendView, phaseBindings, phaseControl, startNext, wideBindings } from "../../workflows/vm/_tree-fixtures.js"

const WIDE_GROUP = "input-mapped:node:1"
const wideStage = (ordinal: number, position: number) => `${WIDE_GROUP}:item:${ordinal}:phase:${position}`

/** Four items of a stream of two phases: t1 finished both, t2 runs its
 *  first, and t3 and t4 have not started. */
const fourItems = () => frontendView(fourLaneControl(), wideBindings)

describe("the address of an agent view's composer", () => {
  it("gives the composer of a running or waiting agent its item, and none to an agent of a finished item", () => {
    const view = fourItems()
    const address = (agentNodeId: string) => workflowAgentAddress(view, workflowAgentModel(view, { agentNodeId, follow: false })!)
    expect(address(wideStage(2, 1))).toEqual({ target: "t2", label: "item t2", placeholder: "Message item t2" })
    expect(address(wideStage(3, 2))).toEqual({ target: "t3", label: "item t3", placeholder: "Message item t3" })
    expect(address(wideStage(1, 2))).toBeUndefined()
    const phase = frontendView(startNext(phaseControl(true)), phaseBindings(true))
    const review = phase.tree.nodes.filter(({ kind }) => kind === "agent")[1]!.id
    expect(workflowAgentAddress(phase, workflowAgentModel(phase, { agentNodeId: review, follow: false })!)).toEqual({ target: "review", label: "agent review", placeholder: "Message agent review" })
  })
})
