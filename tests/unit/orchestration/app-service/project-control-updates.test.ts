/**
 * Update state as a project serves it. Updates are account-wide, so the
 * project's control facade answers them from the account's one coordinator
 * and publishes each view the coordinator announces, and nothing about them
 * reaches the project's executor (ARCH-PROTOCOL-043).
 */

import { expect, test } from "bun:test"
import { createProjectControlClient, type ProjectControlClientOptions, type ProjectControlExecutor } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import type { UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"
import { servingAccountService } from "../../../helpers/account-service-state.js"
import { recordingAccountUpdates } from "../../../helpers/account-updates.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"

const unused = (): never => { throw new Error("this case does not reach it") }

/** An executor that records and refuses everything, so any update traffic
 *  that reaches it fails the case by name. */
function refusingExecutor() {
  const asked: string[] = []
  const client: ProjectControlExecutor = {
    query: async (request) => { asked.push(request.type); throw new Error(`the executor was asked for ${request.type}`) },
    dispatch: async (command) => { asked.push(command.type); throw new Error(`the executor was sent ${command.type}`) },
    hideSession: async () => { asked.push("hide"); throw new Error("the executor was sent a hide") },
    subscribe: () => () => {},
    async close() {},
  }
  return { client, asked }
}

function options(executor: ProjectControlExecutor, updates: ProjectControlClientOptions["updates"]): ProjectControlClientOptions {
  return {
    executor, updates, service: servingAccountService(), bus: createRuntimeUiBus(), directories: { projectRoot: "/workspace" }, executionCwd: "/workspace", runtimeVersion: "test", runtimeBuildId: null,
    chatDefault: () => ({ kind: "pending" }), setChatDefault: unused, onError(error) { throw error }, endIfWedged: unused, executorState: () => ({ kind: "serving" }),
    awaitGenerationRecovery: async () => {}, authProfiles: { inspect: unused },
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
    state: { ...asAsyncEventReadSurface(inMemoryEventReader([])), onStored: () => () => {}, sessions: {
      allocateId: unused, createChat: unused, listForIds: async () => ({ sessions: [], errors: [] }),
      read: unused, updateLabel: unused, updateLifecycleState: unused, subscribe: () => () => {}, interruptOwed: unused,
    } },
    history: { start() {}, dispose: async () => {}, recall: unused, transcriptSearch: unused, snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }), sessionSummaryImmediate: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }), waitForTotals: unused,
      sessionDetail: unused, sessionChangeSummary: unused, moduleSnapshot: unused },
  }
}

test("update state is the account's: the snapshot, each view, and the auto-install setting never reach the executor", async () => {
  const executor = refusingExecutor()
  const updates = recordingAccountUpdates()
  const clientOptions = options(executor.client, updates.port)
  const client = createProjectControlClient(clientOptions)
  const events: FrontendEvent[] = []
  client.subscribe((event) => events.push(event))

  expect((await client.query({ type: "updateSnapshot" })).update.status).toEqual({ kind: "idle" })
  const installing: UpdateStatusView = { revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "installing", version: "1.3.0" }, releaseNotice: { version: "1.2.0", message: "Updated to v1.2.0.", url: "https://github.com/wsauret/flywheel/releases" } }
  updates.publish(installing)
  await clientOptions.bus?.drain()
  const published = events.flatMap((event) => event.type === "patch" && event.patch.payload.kind === "update.changed" ? [event.patch.payload.update] : [])
  expect(published).toEqual([installing])
  expect((await client.query({ type: "updateSnapshot" })).update).toEqual(installing)
  expect(await client.dispatch({ type: "settings.set_update_auto_install", expected: true, value: false })).toEqual({ ok: true })
  expect(updates.writes).toEqual([false])
  expect(executor.asked).toEqual([])

  // A closed project stops hearing the account, which outlives it, and a
  // setting sent to it after closure never reaches the durable policy.
  await client.close()
  expect(updates.listeners.size).toBe(0)
  await expect(client.dispatch({ type: "settings.set_update_auto_install", expected: false, value: true })).rejects.toThrow(/closed/)
  expect(updates.writes).toEqual([false])
  await clientOptions.bus?.clear()
})
