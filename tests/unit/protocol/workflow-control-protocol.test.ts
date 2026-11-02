import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { FrontendMutationSchema, RuntimeQuerySchema, RuntimeUiPatchSchema } from "../../../src/protocol/runtime-protocol-schemas.js"
import { workflowsProtocol, workflowLiveCursor } from "../../../src/protocol/modules/workflows.js"
import { cursorKey } from "../../../src/protocol/runtime-ui-protocol-types.js"

describe("workflow control wire contract", () => {
  for (const type of ["workflow.interrupt", "workflow.resume"] as const) {
    it(`${type} preserves targets and accepts whole-workflow controls`, () => {
      const decode = Schema.decodeUnknownSync(FrontendMutationSchema)
      for (const targets of [undefined, [], ["json"]]) {
        const input = { type, workflowId: "workflow", ...(targets === undefined ? {} : { targets }) }
        expect(decode(input)).toEqual(input)
      }
      expect(() => decode({ type, workflowId: "workflow", targets: [""] })).toThrow()
      expect(() => decode({ type, sessionId: "workflow" })).toThrow()
    })
  }
  it("preserves an attempt's original park time in the workflow's live state", () => {
    const patch = { kind: "workflow_live.changed", agents: [{ attemptId: "json", sessionId: "member", operations: 2, interruptedAt: 1000, duration: 0, revision: 4 }] } as const
    const codec = workflowsProtocol.domains[2].patch
    const encoded = Schema.encodeUnknownSync(codec)(patch)
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(patch)
  })
  it("routes workflow reads without a session alias and isolates equal ids on different owners", () => {
    const decode = Schema.decodeUnknownSync(RuntimeQuerySchema)
    for (const type of ["workflowDetail", "workflowViewSnapshot", "workflowLiveSnapshot"] as const) {
      expect(decode({ type, workflowId: "shared" })).toEqual({ type, workflowId: "shared" })
      expect(() => decode({ type, sessionIds: ["shared"] })).toThrow()
    }
    const patch = { cursor: workflowLiveCursor("shared"), position: 1, prevPosition: 0, payload: { kind: "workflow_live.changed", agents: [], order: [] } } as const
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    expect(cursorKey(patch.cursor)).not.toBe(cursorKey({ scope: "session", domain: "output", sessionId: "shared" }))
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema)({ ...patch, cursor: { scope: "session", domain: "workflow_live", sessionId: "shared" } })).toThrow()
  })
})
