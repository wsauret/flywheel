import { Layer } from "effect"
import { Socket } from "effect/unstable/socket"

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { createClientActions, type ClientActions } from "../client/actions.js"
import { createReadingPlace } from "../client/reading-place.js"
import { createRuntimeSession, type RuntimeSession } from "../client/session.js"
import type { PanelSettings } from "../client/session-settings.js"
import { modulesView } from "../../../tests/helpers/runtime-views.js"
import { createViewProjection, type ClientViewState, type SessionSummary } from "../client/view-state.js"
import type { ClientHost } from "../host.js"
import type { WebModuleClientHost } from "../web-module-client.js"
import type { ClientContextValue } from "./client-context.js"
import { createWebSurfaces } from "./surfaces.js"

/** Typed fakes of everything a client component reaches, for render and
 *  interaction fixtures. Each builder returns a complete value of its type:
 *  defaults come from the real owners where one builds synchronously, and an
 *  override replaces a member whole. The fake connection comes from
 *  `../client/runtime-connection-fixture.js`. */

/** The real session over `connection`, with `members` in place of its own.
 *  The real session's own code keeps its own members; the replacements are
 *  what its callers, such as the actions layer, reach. The default connection
 *  never opens a lane, so the session reads nothing on its own. A reading
 *  that a caller starts, such as a mounted surface's role or detail
 *  subscription, fails on the fake connection and retries on real timers
 *  until the caller disposes the session. */
export function fakeRuntimeSession(members: Partial<RuntimeSession> = {}, connection: RuntimeConnection = fakeRuntimeConnection({}, fakeLanes({ open: false }).client)): RuntimeSession {
  return Object.defineProperties(createRuntimeSession({ connection }), Object.getOwnPropertyDescriptors(members))
}

/** The real actions layer over `session` and `connection`, with `members`
 *  in place of its own. The default session is idle, so an action that reads
 *  it finds no session open. */
export function fakeClientActions(members: Partial<ClientActions> = {}, session: RuntimeSession = fakeRuntimeSession(), connection: RuntimeConnection = fakeRuntimeConnection()): ClientActions {
  const actions = createClientActions({ session, connection, capabilities: {}, report: () => {}, captureSurfaceOpener: () => () => {} })
  // A spread would freeze the live `mutationEvidence` getter into a one-time value.
  return Object.defineProperties(actions, Object.getOwnPropertyDescriptors(members))
}

/** The frame the real projection draws for a session that has read nothing
 *  yet, with `fields` in place of its own. */
export function fakeViewState(fields: Partial<ClientViewState> = {}): ClientViewState {
  const session = fakeRuntimeSession()
  const idle = createViewProjection()(session)
  session.dispose()
  return { ...idle, ...fields }
}

/** Settings as a runtime with one profile and no module, provider, or
 *  configuration problem reads them, with `fields` in place of its own. The
 *  runtime's settings reads are asynchronous, so these defaults are written out. */
export function fakePanelSettings(fields: Partial<PanelSettings> = {}): PanelSettings {
  const capabilities = modulesView()
  return {
    capabilities, moduleIds: [], capabilitiesOn: 0, capabilitiesTotal: 0, capabilityPreset: "custom",
    workflowMode: capabilities.workflowsMode, persistentProcesses: capabilities.persistentProcesses, moduleSettings: [],
    compactionThreshold: 50_000, idleCompaction: true, autoDeleteSessionDays: 0, webSearchProvider: "chatgpt",
    showThinking: true, showBuild: false, writeSyntaxTheme: "nord", diffColors: "theme",
    profileId: "default", providerSettings: [], gitAiAttribution: false, allowTrainingRoutes: false, problems: [],
    profile: { displayName: "Default", count: 1 }, configProblems: [],
    seatSlot: { kind: "role", roleId: "chat" }, seatEfforts: [],
    ...fields,
  }
}

/** A listed or opened session at rest, as the projection summarizes its row,
 *  with `fields` in place of its own. */
export function fakeSessionSummary(fields: Pick<SessionSummary, "id" | "kind" | "title"> & Partial<SessionSummary>): SessionSummary {
  return { lifecycleState: "active", active: true, working: false, lastUpdated: "2026-01-01T00:00:00.000Z", totalsLoading: true, ...fields }
}

/** A host with no capabilities whose socket fails when a fixture attaches. */
export function fakeClientHost(fields: Partial<ClientHost> = {}): ClientHost {
  return { capabilities: {}, socket: Layer.sync(Socket.Socket, () => { throw new Error("The fake host has no socket") }), ...fields }
}

const refuseDialog = (kind: string) => (): never => {
  throw new Error(`The fake client has no ${kind} answer`)
}

/** A client context over a fake connection, an idle real session, the real
 *  actions layer, and the idle frame, with `members` in place of its own. The
 *  default session never reads, so it needs no answers from `connection`. A
 *  dialog the fixture does not answer throws; every other callback does nothing. */
export function fakeClient(members: Partial<ClientContextValue> = {}): ClientContextValue {
  const connection = members.connection ?? fakeRuntimeConnection()
  const session = fakeRuntimeSession()
  const noop = () => {}
  const view = fakeViewState()
  const client: ClientContextValue = {
    signal: new AbortController().signal,
    changes: () => undefined,
    host: fakeClientHost(),
    connection,
    actions: fakeClientActions({}, session, connection),
    state: () => view,
    report: noop,
    openSheet: noop,
    closeSheet: noop,
    retryLoginQuestion: noop,
    sheetFocus: () => undefined,
    confirm: refuseDialog("confirmation"),
    prompt: refuseDialog("prompt"),
    focusComposer: noop,
    insertText: noop,
    recallLocal: noop,
    openFind: noop,
    openMentions: noop,
    pickFiles: noop,
    openSurface: (id, opening) => client.surface(id)?.open(opening),
    // The real table over this fake's own members, so an overridden sheet
    // or action is what a surface opens.
    surface: createWebSurfaces(() => client, new Map()),
    markedBlock: () => undefined,
    markBlock: noop,
    readingPlace: createReadingPlace(undefined),
    residents: session,
    ...members,
  }
  return client
}

/** A module host over a fake connection, an idle real session, the real
 *  actions layer, and the idle frame, with `members` in place of its own. */
export function fakeWebModuleHost(members: Partial<WebModuleClientHost> = {}): WebModuleClientHost {
  const connection = members.connection ?? fakeRuntimeConnection()
  const session = members.session ?? fakeRuntimeSession()
  const view = fakeViewState()
  return {
    state: () => view,
    connection,
    session,
    actions: fakeClientActions({}, session, connection),
    selectSession: () => {},
    report: () => {},
    ...members,
  }
}
