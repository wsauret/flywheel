import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createMemoryStore } from "../../workflows/vm/host-test-support.js"
import { releaseHeldProjections } from "../../../../src/infra/projection-registry.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { composeModuleProtocolRuntimes, type ModuleProtocolServices } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { experimentsModule } from "../../../../src/orchestration/modules/experiments.js"
import { createExperimentsProtocol } from "../../../../src/orchestration/modules/experiments/protocol.js"
import type { FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import { protocolBackgroundSchema } from "../../../../src/protocol/modules.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

const noopOutputProjection = { flush: async (_sessionId: string) => {}, watch: () => {}, dispose: () => {} }

function view(running: boolean): FrontendExperimentView {
  return {
    name: "speed", metric: { name: "latency_ms", unit: "ms" }, secondaryMetrics: [], direction: "lower", segment: 0,
    baseline: 10, best: 9, confidence: null, runCounts: { total: 1, kept: 1, discarded: 0, crashed: 0, checksFailed: 0 },
    runs: [{ run: 1, segment: 0, commit: "abc", metric: 9, metrics: {}, status: "keep", description: "kept", confidence: null, durationMs: 120 }],
    active: true, running,
  }
}

const readers = new Array<ReturnType<typeof inMemoryEventReader>>()
afterEach(() => {
  for (const reader of readers.splice(0)) releaseHeldProjections(asAsyncEventReadSurface(reader))
})

/** The experiments protocol runtime over a store with one live session and no
 *  experiment history, so a live read answers null and never asks the Worker. */
function experimentsServices(liveIds: string[]) {
  const store = fakeSessionStore(new Map(liveIds.map((id) => [id, chatEntry()])))
  const reader = inMemoryEventReader([])
  readers.push(reader)
  const calls = { background: new Array<string>() }
  const bus = createRuntimeUiBus()
  const services: ModuleProtocolServices = {
    projectionReader: asAsyncEventReadSurface(reader),
    eventWriter: asAsyncEventWriter(createMemoryStore([])),
    manager: fakeManager(),
    eventStore: asAsyncEventReadSurface(reader), sessionStore: store, definitions: repoDefinitions(), onStored: () => () => {}, publish: bus.publish, snapshotPosition: bus.snapshotPosition, modules: NO_MODULE_SERVICES, enabled: () => true,
    interruptSession: async () => false,
    hasLiveSession: (sessionId) => store.has(sessionId),
    background: async (domain, sessionId) => {
      calls.background.push(`${domain}:${sessionId}`)
      // The background lane decodes the Worker's answer with the domain's own codec; the double does the same.
      return Schema.decodeUnknownSync(protocolBackgroundSchema(domain))({ experimentView: view(false) })
    },
  }
  return { services, calls }
}

function experimentsRuntime(liveIds: string[]) {
  const { services, calls } = experimentsServices(liveIds)
  return { runtime: createExperimentsProtocol(services), calls }
}

describe("experiments protocol runtime", () => {
  test("a live session is served by the local projection and never by the background lane", async () => {
    const { runtime, calls } = experimentsRuntime(["chat-live"])

    const result = await runtime.serve.experimentViewSnapshot({ type: "experimentViewSnapshot", sessionId: "chat-live" })

    expect(result).toEqual({ experimentView: null, snapshotPosition: 0 })
    expect(calls.background).toEqual([])
    runtime.dispose()
  })

  test("an inactive session is served by the background lane and never by the live projection", async () => {
    const { runtime, calls } = experimentsRuntime([])

    const result = await runtime.serve.experimentViewSnapshot({ type: "experimentViewSnapshot", sessionId: "old-chat" })

    expect(result).toEqual({ experimentView: view(false), snapshotPosition: 0 })
    expect(calls.background).toEqual(["experiment_view:old-chat"])
    runtime.dispose()
  })
})

describe("FlywheelAppService module queries", () => {
  function harness() {
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const calls = { served: new Array<string>(), disposed: 0 }
    const routes = composeModuleProtocolRuntimes([experimentsModule], experimentsServices([]).services, () => [experimentsModule.id])
    const service = createFlywheelAppService({
      projectRoot: tmpdir(),
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      runtimeSupervisor: runtimeSupervisor(),
      ...fakeProjections(),
      outputProjection: noopOutputProjection,
      moduleProtocol: {
        ...routes,
        serve(query) {
          calls.served.push(query.type)
          return routes.serve(query)
        },
        dispose: () => {
          calls.disposed += 1
          routes.dispose()
        },
      },
    })
    return { service, calls }
  }

  test("a module query is routed to the module protocol runtime by its discriminant, with no module case in the service", async () => {
    const { service, calls } = harness()

    const result = await service.query({ type: "experimentViewSnapshot", sessionId: "chat-1" })

    expect(result).toEqual({ experimentView: view(false), snapshotPosition: 0 })
    expect(calls.served).toEqual(["experimentViewSnapshot"])
  })

  test("startup touches no module runtime; shutdown disposes it once", async () => {
    const { service, calls } = harness()
    expect(calls).toEqual({ served: [], disposed: 0 })

    await runRuntimeShutdownBarrier(service.shutdown)

    expect(calls.disposed).toBe(1)
  })
})
