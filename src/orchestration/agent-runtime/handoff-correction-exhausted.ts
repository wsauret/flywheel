// The agent broke its handoff contract: every correction the bounded loop
// allowed was rejected (see agent-loop-handoff.ts). It is a plain Error outside
// AgentRuntimeError because the model request did not fail, so it must never
// map to a provider failure. The run rejects with it, and the owner of the
// handoff contract reports it in its own terms.
export class HandoffCorrectionExhausted extends Error {
  readonly _tag = "HandoffCorrectionExhausted" as const

  constructor(input: { readonly message: string }) {
    super(input.message)
    this.name = "HandoffCorrectionExhausted"
  }
}
