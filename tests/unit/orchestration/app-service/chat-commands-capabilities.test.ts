import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { moduleDescriptor } from "../../../../src/orchestration/config/module-descriptor.js"
import type { CapabilityAdmission, CapabilityRequest } from "../../../../src/orchestration/config/module-policy.js"
import { composeRealmModuleSnapshot, type ModuleId } from "../../../../src/orchestration/modules.js"
import { createCommandInvokeService } from "../../../../src/orchestration/app-service/command-invoke-service.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { testDirectories } from "../../../helpers/directories.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

function policy(held: readonly ModuleId[]) {
  const requests: CapabilityRequest[] = []
  return {
    requests,
    state: () => moduleDescriptor(held, held, true),
    admit: async (request: CapabilityRequest): Promise<CapabilityAdmission> => {
      requests.push(request)
      const missing = request.required.filter((capability) => !held.includes(capability))
      return missing.length === 0
        ? { ok: true, grant: { operation: request.operation, required: request.required, ...moduleDescriptor(held, held, true) } }
        : { ok: false, missing, reason: `${request.operation} is unavailable: learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml` }
    },
  }
}

/** Invokes `/learn` the way a client does, through the runtime's command
 *  service over a supervisor whose runner counts reviews. `published` is the
 *  roster the service resolves against; `held` is what policy admits. */
async function learnWith(published: readonly ModuleId[], held: readonly ModuleId[]) {
  let reflects = 0
  const capabilities = policy(held)
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, {
      capabilities,
      createRunner: async (deps) => mockRunner(deps.sessionId, { learn: () => { reflects += 1; return true } }),
    }),
  })
  const sessionId = await supervisor.openSessionRuntime()
  await supervisor.ensureChatRunner(sessionId)
  const { invoke } = createCommandInvokeService({
    catalog: { snapshot: () => ({ revision: 1, builtInCommands: [], offCommands: [] }) },
    availability: { snapshot: () => { throw new Error("/learn starts no method") } },
    moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: published }),
    manager: ctx.manager,
    sessionStore: ctx.sessionStore,
    supervisor,
    projectionReader: asAsyncEventReadSurface(ctx.store),
    eventWriter: ctx.runtime.runSync(EventStoreWriterService),
    directories: testDirectories(ctx.baseDir),
    authDirectory: () => ctx.baseDir,
  })
  const outcome = await invoke({ type: "command.invoke", id: "learn", revision: 1, sessionId })
  await supervisor.disposeAll()
  return { outcome, reflects, requests: capabilities.requests }
}

describe("/learn under capability policy", () => {
  test("fires the manual review while Learning is held", async () => {
    const { outcome, reflects } = await learnWith(["learning"], ["learning"])

    expect(outcome).toEqual({ kind: "none" })
    expect(reflects).toBe(1)
  })

  test("refuses a stale /learn before the review is asked for while Learning is off", async () => {
    // The roster still lists the command, so the runner-side admission is the
    // last line: policy is consulted and the review never starts.
    const { outcome, reflects, requests } = await learnWith(["learning"], [])

    expect(outcome).toEqual({ kind: "warning", message: "No active chat session to review" })
    expect(reflects).toBe(0)
    expect(requests.map((request) => request.required)).toContainEqual(["learning"])
  })

  test("a roster without Learning has no /learn to invoke", async () => {
    const { outcome, reflects, requests } = await learnWith([], [])

    expect(outcome).toEqual({ kind: "unavailable", message: '"/learn" needs the Learning module, which is off. Turn it on in Settings.' })
    expect(reflects).toBe(0)
    expect(requests).toEqual([])
  })
})
