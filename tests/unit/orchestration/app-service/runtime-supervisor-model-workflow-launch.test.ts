import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { modelWorkflowLaunchOrigin } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext

beforeEach(() => {
  ctx = createSupervisorTestContext()
})

afterEach(async () => {
  await disposeSupervisorTestContext(ctx)
})

describe("a model workflow launch through its parent chat actor", () => {
  test("hands the controller every field of the model's intent, stamped with the trusted parent chat", async () => {
    const requests: unknown[] = []
    let launchFromRunner: ChatRunnerDeps["startWorkflow"] | undefined
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, {
      createRunner: async (deps) => { launchFromRunner = deps.startWorkflow; return mockRunner(deps.sessionId) },
      startWorkflow: async (request) => { requests.push(request); return { error: "recorded" } },
    }))
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await expect(supervisor.sendChat(sessionId, "hi")).resolves.toEqual({ ok: true })
      if (!launchFromRunner) throw new Error("the chat runner received no workflow starter")
      const model = { conversationId: "conversation", toolUseId: "workflow-call", confirmation: { kind: "absent" }, authority: fullAuthority() } as const
      const intent = { source: { kind: "path", path: "/scratch/build.workflow.yaml" }, summary: "Build", description: "Build it", launchCwd: "sub" } as const

      await launchFromRunner({ ...intent, model })

      expect(requests).toEqual([{ ...intent, origin: modelWorkflowLaunchOrigin(sessionId, model) }])
    } finally {
      await supervisor.disposeAll()
    }
  })
})
