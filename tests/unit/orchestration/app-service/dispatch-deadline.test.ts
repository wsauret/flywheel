import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CONTROL_RPC_DEADLINE_MS, MODEL_CONFIG_RPC_DEADLINE_MS, OUTPUT_HISTORY_RPC_DEADLINE_MS } from "../../../../src/infra/with-deadline.js"
import { applyRuntimeCallPolicy, RuntimeCallTimeout, runtimeCallPolicies } from "../../../../src/protocol/runtime-client-deadlines.js"

describe("runtimeCallPolicies", () => {
  test("all user-action and mutation calls are lossless", () => {
    expect({
      dispatch: runtimeCallPolicies.dispatch,
      dispatchWorkflow: runtimeCallPolicies.dispatchWorkflow,
      saveModelEffort: runtimeCallPolicies.saveModelEffort,
      resetModelAssignments: runtimeCallPolicies.resetModelAssignments,
      recallQueuedMessage: runtimeCallPolicies.recallQueuedMessage,
    }).toEqual({
      dispatch: { _tag: "Lossless" },
      dispatchWorkflow: { _tag: "Lossless" },
      saveModelEffort: { _tag: "Lossless" },
      resetModelAssignments: { _tag: "Lossless" },
      recallQueuedMessage: { _tag: "Lossless" },
    })
  })

  test("retryable reads retain their best-effort deadline tiers", () => {
    expect(runtimeCallPolicies.snapshot).toEqual({ _tag: "BestEffort", deadlineMs: CONTROL_RPC_DEADLINE_MS })
    expect(runtimeCallPolicies.outputWindow).toEqual({ _tag: "BestEffort", deadlineMs: OUTPUT_HISTORY_RPC_DEADLINE_MS })
    expect(runtimeCallPolicies.outputRange).toEqual({ _tag: "BestEffort", deadlineMs: OUTPUT_HISTORY_RPC_DEADLINE_MS })
    expect(runtimeCallPolicies.modelOptions).toEqual({ _tag: "BestEffort", deadlineMs: MODEL_CONFIG_RPC_DEADLINE_MS })
  })

  test("lossless calls survive longer than a deadline that would previously have fired", async () => {
    const result = await Effect.runPromise(applyRuntimeCallPolicy(
      Effect.sleep(15).pipe(Effect.as("delivered")),
      { _tag: "Lossless" },
    ))

    expect(result).toBe("delivered")
  })

  test("best-effort calls still time out", async () => {
    const result = Effect.runPromise(applyRuntimeCallPolicy(
      Effect.never,
      { _tag: "BestEffort", deadlineMs: 5 },
    ))

    await expect(result).rejects.toBeInstanceOf(RuntimeCallTimeout)
  })
})
