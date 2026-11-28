import { expect, test } from "bun:test"
import { Schema } from "effect"
import { composeModuleServices, type ModuleServices } from "../../../../../src/infra/definitions/modules/module-service.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/substrate/store/event-store-types.js"
import { createFlywheelAppService } from "../../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../../src/orchestration/app-service/projections/frontend-projection.js"
import { composeAccountModuleProtocolRuntimes, composeModuleProtocolRuntimes, type ModuleProtocolServices } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import { createRuntimeUiBus } from "../../../../../src/orchestration/app-service/projections/runtime-ui-bus.js"
import { projectNotificationsModule } from "../../../../../src/orchestration/modules/project-notifications/module.js"
import type { ProjectNotificationsService } from "../../../../../src/orchestration/modules/project-notifications/service.js"
import { projectNotificationsCursor, projectNotificationsDomain, type ProjectNotificationEpisode } from "../../../../../src/protocol/modules/project-notifications.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "../../app-service/app-service-doubles.js"
import { refusingEventWriter } from "../../../../helpers/event-writer-doubles.js"

const episode: ProjectNotificationEpisode = { id: "episode-1", sourceId: "auth:openai", title: "Authentication needed", message: "Sign in.", severity: "warning", action: { kind: "open-auth", providerId: "chatgpt", accountCorrelationId: "opaque-account", envelopeId: "opaque-envelope" }, createdAt: 10, expiresAt: 20 }

test("the protocol decodes recorded actions unchanged and notices without an action", () => {
  const { action: _action, ...actionless } = episode
  const snapshot = { snapshotPosition: 1, notifications: [episode, actionless] }
  expect(Schema.decodeUnknownSync(projectNotificationsDomain.snapshot.result)(snapshot)).toEqual(snapshot)
})

/** The app service over the module's protocol runtime, with the module's service present or absent. */
function serviceOver(modules: ModuleServices, calls: string[], enabledModuleIds: () => readonly string[] = () => [projectNotificationsModule.id], placement: "account" | "standalone" | "executor" = "account") {
  const sessionStore = fakeSessionStore(new Map())
  const manager = fakeManager()
  const bus = createRuntimeUiBus()
  const projections = fakeProjections()
  const configView = { ...projections.config.view(), diagnostics: [] }
  const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
  const protocolServices: Omit<ModuleProtocolServices, "enabled"> = {
    eventStore: reader,
    eventWriter: refusingEventWriter({ pruneSupersededEvents: async () => 0 }),
    projectionReader: reader,
    manager,
    sessionStore,
    definitions: repoDefinitions(),
    onStored: () => () => {},
    publish: bus.publish,
    snapshotPosition(scope) {
      calls.push("anchor")
      expect(scope).toEqual({ kind: "cursor", cursor: projectNotificationsCursor() })
      return 37
    },
    hasLiveSession: () => false,
    background: async () => { throw new Error("The notifications domain reads no background history") },
    modules,
    interruptSession: async () => false,
  }
  const moduleProtocol = placement === "account"
    ? composeAccountModuleProtocolRuntimes([projectNotificationsModule], protocolServices, enabledModuleIds)
    : composeModuleProtocolRuntimes([projectNotificationsModule], protocolServices, enabledModuleIds, placement === "executor")
  const service = createFlywheelAppService({
    projection: createFrontendProjection({ sessionStore, manager, projectRoot: "/workspace" }),
    projectRoot: "/workspace",
    runtimeSupervisor: runtimeSupervisor(),
    bus,
    ...projections,
    moduleProtocol,
    config: { ...projections.config, view: () => configView, refresh: async () => configView },
  })
  return { service, bus }
}

function notificationsService(calls: string[]): ProjectNotificationsService {
  return {
    snapshot: async (anchor) => {
      calls.push("visible")
      return { notifications: [episode], anchor: anchor() }
    },
    dismiss: async (sourceId, episodeId) => { calls.push(`dismiss:${sourceId}:${episodeId}`) },
    sink: { apply: async () => {}, closeAdmission: () => {}, settled: async () => {} },
    dispose: () => {},
  }
}

test("the snapshot reads the shown episodes before anchoring and dismiss routes to the module by registry lookup", async () => {
  const calls: string[] = []
  const modules = composeModuleServices([[projectNotificationsModule.id, notificationsService(calls)]])
  const { service, bus } = serviceOver(modules, calls)
  expect(await service.query({ type: "projectNotificationSnapshot" })).toEqual({ notifications: [episode], snapshotPosition: 37 })
  expect(calls).toEqual(["visible", "anchor"])
  expect(await service.dispatch({ type: "project_notifications.dismiss", sourceId: episode.sourceId, episodeId: episode.id })).toEqual({ ok: true })
  expect(calls).toEqual(["visible", "anchor", `dismiss:${episode.sourceId}:${episode.id}`])
  await bus.clear()
})

test("standalone control owns notifications while account-attached execution does not", async () => {
  const calls: string[] = []
  const modules = composeModuleServices([[projectNotificationsModule.id, notificationsService(calls)]])
  const standalone = serviceOver(modules, calls, () => [projectNotificationsModule.id], "standalone")
  const executor = serviceOver(modules, calls, () => [projectNotificationsModule.id], "executor")
  expect((await standalone.service.query({ type: "projectNotificationSnapshot" })).notifications).toEqual([episode])
  await expect(executor.service.query({ type: "projectNotificationSnapshot" })).rejects.toThrow("No installed module serves")
  await Promise.all([standalone.bus.clear(), executor.bus.clear()])
})

test("turned off at runtime with its service still built, the snapshot is empty and a dismiss is refused", async () => {
  const calls: string[] = []
  const modules = composeModuleServices([[projectNotificationsModule.id, notificationsService(calls)]])
  const { service, bus } = serviceOver(modules, calls, () => [])
  expect(await service.query({ type: "projectNotificationSnapshot" })).toEqual({ notifications: [], snapshotPosition: 37 })
  expect(await service.dispatch({ type: "project_notifications.dismiss", sourceId: episode.sourceId, episodeId: episode.id })).toEqual({ ok: false, error: "Project notifications are off" })
  expect(calls).toEqual(["anchor"])
  await bus.clear()
})
