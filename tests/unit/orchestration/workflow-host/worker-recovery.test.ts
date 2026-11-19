import { expect, it } from "bun:test"
import { createEmit } from "../../../../src/infra/event-bus"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { registerCapacityWaits } from "../../../../src/orchestration/session/capacity-wait"
import { readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { liveSessionControl } from "../../../../src/orchestration/session/live-session-control"
import { newTestRunner } from "../../../helpers/agent-runner"
import { attemptBrief } from "../../../helpers/attempt-brief"
import { temporaryDirectories } from "../../../helpers/directories"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { handoverAuthority } from "../agent-runtime/_command-handover-fixtures"
import { CONVERSATION, handoverWorker, publishStep, STEP, WORKFLOW } from "./_worker-step-fixtures"
import { makeWorkflowDeps } from "./_workflow-controller-fixtures"

const temporary = temporaryDirectories()

it("parks a step with a model that fails selection without starting another run until Resume (ARCH-RUNTIME-082)", async () => {
  const dir = temporary("step-unserved-interrupt-")
  const { store, sessionId } = await publishStep(dir)
  const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
  const ledger = registerCapacityWaits(authority.reader, { reader: authority.projectionReader, writer: authority.writer })
  const inputs = workflowAgentInputs(authority.projectionReader, WORKFLOW)
  const stop = new AbortController()
  const firstWait = Promise.withResolvers<unknown>()
  const secondWait = Promise.withResolvers<unknown>()
  const parked = Promise.withResolvers<"parked">()
  let attempts = 0
  const emit = createEmit({ emit(event) {
    if (event.type === "agent.turn.parked" && event.data.park === "interrupted") parked.resolve("parked")
    if (event.type === "agent.notice.changed") {
      const { operation } = event.data
      if (operation.type === "upsert" && operation.notice.title === "Waiting for model capacity") {
        (attempts === 1 ? firstWait : secondWait).resolve(operation.notice.wait)
      }
    }
  } })
  const model = "unoffered-test-model"
  const { captureProviderConnection } = makeWorkflowDeps()
  const worker = handoverWorker(dir, (options) => {
    attempts += 1
    return newTestRunner({ ...options, agentsMd: "", resolveEnvSnapshot: undefined, requestSelection: () => ({ model, roleId: "workflow-agent" }) },
      async () => { throw new Error("An unoffered model must fail before creating a client") }, undefined, captureProviderConnection)
  }, authority, emit, inputs)
  const run = worker(STEP, attemptBrief("work"), stop.signal, CONVERSATION)
  try {
    expect(await Promise.race([firstWait.promise, run.then(() => "ended")])).toMatchObject({ model, reason: "not_offered" })
    const control = liveSessionControl(authority.reader, sessionId)
    expect(control?.member?.interrupt("person")).toBe(true)
    expect(await Promise.race([parked.promise, secondWait.promise.then(() => "rearmed"), run.then(() => "ended")])).toBe("parked")
    expect(attempts).toBe(1)
    expect(await control?.state()).toBe("interrupted")
    expect(await readChatTurnEnd(authority.projectionReader, CONVERSATION)).toMatchObject({ end: { reason: "paused", pausedBy: "person" } })
    expect(inputs.agentInputs.resume()).toEqual([STEP.id])
    expect(await secondWait.promise).toMatchObject({ model, reason: "not_offered" })
    expect(attempts).toBe(2)
    expect(await control?.state()).toBe("running")
  } finally {
    stop.abort()
    await run
    ledger.dispose()
    store.close()
  }
})
