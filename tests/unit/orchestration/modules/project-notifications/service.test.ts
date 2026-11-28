import { expect, test } from "bun:test"
import { join } from "node:path"

import { composeModules } from "../../../../../src/infra/definitions/module-descriptor.js"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../../../src/infra/substrate/events/notification-episode.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../../src/infra/substrate/store/event-store-types.js"
import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { composeModuleProcessServices, createNotifySeam, type ProfileStateStore } from "../../../../../src/orchestration/app-service/executor/execution/module-service-host.js"
import type { ControlModuleServices } from "../../../../../src/orchestration/app-service/account/projects/account-module-services.js"
import { composeRealmModuleSnapshot } from "../../../../../src/orchestration/module-contract/module-composition.js"
import type { FirstPartyModule } from "../../../../../src/orchestration/module-contract/module-catalog.js"
import { projectNotificationsModule } from "../../../../../src/orchestration/modules/project-notifications/module.js"
import { createProjectNotificationsService, projectNotificationsService, type ProjectNotificationsService } from "../../../../../src/orchestration/modules/project-notifications/service.js"
import { authStatusCursor, type RuntimeAuthView } from "../../../../../src/protocol/auth/auth-status-protocol-types.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../../src/protocol/auth/subscription-spend-consent-protocol-types.js"
import type { FrontendEvent } from "../../../../../src/protocol/runtime/app-service-types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { kernelPorts } from "../../../../helpers/module-kernel.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"

const tempDir = temporaryDirectories()
const occurrence = (sourceId: string): NotificationOccurrence => ({ sourceId, title: "Provider is off", message: "Turn it on in Settings.", severity: "warning", action: { kind: "open-auth" } })
const raise = (sourceId: string, profileId?: string): NotificationEpisodeInput => ({ type: "raise", ...(profileId === undefined ? {} : { profileId }), occurrence: occurrence(sourceId) })
const resolve = (sourceId: string, profileId?: string): NotificationEpisodeInput => ({ type: "resolve", ...(profileId === undefined ? {} : { profileId }), sourceId })
const list = async (service: ProjectNotificationsService) => (await service.snapshot(() => 0)).notifications
const shown = async (project: Project): Promise<string[]> => (await list(project.service)).map((episode) => episode.sourceId)

interface Project {
  readonly service: ProjectNotificationsService
  readonly published: RuntimeUiPatchInput[]
  /** Delivers a workspace auth view that names `profileId`, as the executor publishes one. */
  switchProfile(profileId: string): void
}

/** One account host: the account store every project shares for profile
 *  state, and projects that each keep their own store. */
function accountHost(options: { readonly countProfileReads?: boolean } = {}) {
  const directory = tempDir("profile-notifications-")
  const accountFile = join(directory, "account.sqlite")
  const account = createSqliteEventStore(accountFile)
  const counter = countStateRequests<AsyncEventStateReadSurface>(asAsyncEventReadSurface(account))
  const profileStore: ProfileStateStore = {
    dbFile: accountFile,
    reader: options.countProfileReads ? counter.reader : asAsyncEventReadSurface(account),
    writer: asAsyncEventWriter(account),
    onStored: account.onStored,
  }
  const stores: ReturnType<typeof createSqliteEventStore>[] = [account]
  const services: ProjectNotificationsService[] = []
  const open = (name: string, profileId: string): Project => {
    const store = createSqliteEventStore(join(directory, `${name}.sqlite`))
    stores.push(store)
    const published: RuntimeUiPatchInput[] = []
    const listeners = new Set<(event: FrontendEvent) => void>()
    const control: ControlModuleServices = {
      projectionReader: asAsyncEventReadSurface(store),
      eventWriter: asAsyncEventWriter(store),
      onStored: store.onStored,
      publish: (patch) => { published.push(patch); return undefined },
      notify: async () => {},
      profileStore,
      authProfileId: () => profileId,
      onFrontendEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const service = createProjectNotificationsService(control)
    services.push(service)
    return {
      service,
      published,
      switchProfile(next) {
        const auth: RuntimeAuthView = { providers: [], warnings: [], profile: { id: next, displayName: next, source: "sticky", availableProfiles: [] }, subscriptionSpendConsent: { kind: "unavailable", profileId: next, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } }
        const event: FrontendEvent = { type: "patch", patch: { cursor: authStatusCursor(), position: 1, prevPosition: 0, payload: { kind: "auth.changed", auth } } }
        for (const listener of listeners) listener(event)
      },
    }
  }
  return {
    open,
    counter,
    /** Disposes every project, as the account does when it stops, and closes the stores. */
    async close() {
      await Promise.all(services.splice(0).map((service) => service.dispose()))
      for (const store of stores.splice(0)) store.close()
    },
    /** Disposes every project but keeps the stores, as a restart of the account does. */
    async restart() {
      await Promise.all(services.splice(0).map((service) => service.dispose()))
    },
  }
}

test("a profile episode raised in one project shows in every project of that profile, and one dismissal hides it in all of them", async () => {
  const host = accountHost()
  try {
    const first = host.open("first", "personal")
    const second = host.open("second", "personal")
    const other = host.open("other", "work")
    await Promise.all([list(first.service), list(second.service), list(other.service)])

    await first.service.sink.apply(raise("runtime:auth-attention:personal:provider:antigravity", "personal"))
    expect(await shown(second)).toEqual(["runtime:auth-attention:personal:provider:antigravity"])
    expect(await shown(other)).toEqual([])
    // A client of the second project hears the episode as it lands.
    expect(second.published.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised"])

    const [episode] = await list(first.service)
    if (!episode) throw new Error("expected the profile episode")
    await first.service.dismiss(episode.sourceId, episode.id)
    expect(await shown(first)).toEqual([])
    expect(await shown(second)).toEqual([])
    expect(second.published.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed"])

    // The condition still holds after a restart: its statement repeats the
    // active source, which keeps the same dismissed episode.
    await host.restart()
    const reopened = host.open("second", "personal")
    await reopened.service.sink.apply(raise("runtime:auth-attention:personal:provider:antigravity", "personal"))
    expect(await shown(reopened)).toEqual([])
  } finally {
    await host.close()
  }
})

test("a project episode stays in its project, and a real recurrence of a profile condition raises a new episode", async () => {
  const host = accountHost()
  try {
    const first = host.open("first", "personal")
    const second = host.open("second", "personal")
    await first.service.sink.apply(raise("runtime:config-warning"))
    expect(await shown(first)).toEqual(["runtime:config-warning"])
    expect(await shown(second)).toEqual([])

    const source = "subscription-usage:personal:weekly"
    await first.service.sink.apply(raise(source, "personal"))
    const [dismissed] = (await list(second.service)).filter((episode) => episode.sourceId === source)
    if (!dismissed) throw new Error("expected the profile episode")
    await second.service.dismiss(source, dismissed.id)
    await first.service.sink.apply(resolve(source, "personal"))
    await first.service.sink.apply(raise(source, "personal"))

    const recurred = (await list(second.service)).filter((episode) => episode.sourceId === source)
    expect(recurred).toHaveLength(1)
    expect(recurred[0]?.id).not.toBe(dismissed.id)
  } finally {
    await host.close()
  }
})

test("a profile statement retires the project's earlier copy of its source, and a profile switch rebases the list", async () => {
  const host = accountHost()
  try {
    const project = host.open("project", "personal")
    const source = "runtime:auth-attention:personal:provider:antigravity"
    // Recorded before producers declared their profile.
    await project.service.sink.apply(raise(source))
    expect(await shown(project)).toEqual([source])

    await project.service.sink.apply(raise(source, "personal"))
    const visible = await list(project.service)
    expect(visible.map((episode) => episode.sourceId)).toEqual([source])
    await project.service.dismiss(source, visible[0]?.id ?? "")
    expect(await shown(project)).toEqual([])

    await project.service.sink.apply(raise("runtime:auth-attention:work:file", "work"))
    expect(await shown(project)).toEqual([])
    project.switchProfile("work")
    expect(project.published.at(-1)?.payload).toEqual({ kind: "runtime.invalidate", reason: "rebase" })
    expect(await shown(project)).toEqual(["runtime:auth-attention:work:file"])
  } finally {
    await host.close()
  }
})

// Another project of the profile holds its own copy of the source from
// before producers declared their profile. Its client hears the copy leave
// before the profile's episode arrives, as a snapshot would show it.
test("a profile raise retires every project's earlier copy of its source, live and durably", async () => {
  const host = accountHost()
  try {
    const first = host.open("first", "personal")
    const second = host.open("second", "personal")
    const source = "runtime:auth-attention:personal:provider:antigravity"
    await second.service.sink.apply(raise(source))
    const [copy] = await list(second.service)
    if (!copy) throw new Error("expected the project copy")
    second.published.length = 0

    await first.service.sink.apply(raise(source, "personal"))
    const kinds = second.published.map((patch) => patch.payload)
    expect(kinds.slice(0, 2)).toMatchObject([{ kind: "project_notifications.dismissed", episodeId: copy.id }, { kind: "project_notifications.raised" }])
    const visible = await list(second.service)
    expect(visible.map((episode) => episode.sourceId)).toEqual([source])
    expect(visible[0]?.id).not.toBe(copy.id)
  } finally {
    await host.close()
  }
})

// A switch of the profile while a snapshot reads publishes a rebase, which
// the snapshot's anchor covers, so the list it answers is the new profile's.
test("a snapshot that a profile switch overtakes answers the new profile's list", async () => {
  const host = accountHost()
  try {
    const project = host.open("project", "personal")
    await project.service.sink.apply(raise("runtime:auth-attention:personal:file", "personal"))
    await project.service.sink.apply(raise("runtime:auth-attention:work:file", "work"))
    const anchors: number[] = []
    const reading = project.service.snapshot(() => anchors.push(project.published.length))
    project.switchProfile("work")
    const { notifications } = await reading
    expect(notifications.map((episode) => episode.sourceId)).toEqual(["runtime:auth-attention:work:file"])
    // The anchor follows every publication, the rebase among them.
    expect(anchors).toEqual([project.published.length])
    expect(project.published.map((patch) => patch.payload)).toContainEqual({ kind: "runtime.invalidate", reason: "rebase" })
  } finally {
    await host.close()
  }
})

// One change to a profile's journal folds and reads once for the host and
// fans out by patches, however many projects show it and however long its
// history is.
test("a profile change costs the same reads for two projects or eight, and for short or long history", async () => {
  const cost = async (projects: number, history: number): Promise<{ requests: number; facts: number }> => {
    const host = accountHost({ countProfileReads: true })
    try {
      const opened = Array.from({ length: projects }, (_, index) => host.open(`project-${index}`, "personal"))
      for (let entry = 0; entry < history; entry += 1) {
        await opened[0]?.service.sink.apply(raise(`history:${entry}`, "personal"))
        await opened[0]?.service.sink.apply(resolve(`history:${entry}`, "personal"))
      }
      await Promise.all(opened.map((project) => list(project.service)))
      host.counter.take()

      await opened[0]?.service.sink.apply(raise("runtime:auth-attention:personal:provider:antigravity", "personal"))
      const requests = host.counter.take()
      for (const project of opened) expect(project.published.at(-1)?.payload.kind).toBe("project_notifications.raised")
      return { requests: requests.length, facts: factsRead(requests) }
    } finally {
      await host.close()
    }
  }
  const baseline = await cost(2, 2)
  expect(await cost(8, 2)).toEqual(baseline)
  expect(await cost(2, 20)).toEqual(baseline)
})

// A composition that owns the service itself closes every service's admission
// when shutdown begins, then stops its runners, then disposes the services in
// the durable flush. Runners that stop still state their conditions, so the
// sink must take them until that flush, as the account's sink does for an
// executor that stops before the account settles it.
test("the sink takes a producer's episode after shutdown begins and refuses one after the durable flush", async () => {
  const directory = tempDir("notification-service-")
  const store = createSqliteEventStore(join(directory, "events.sqlite"))
  const account = createSqliteEventStore(join(directory, "account.sqlite"))
  try {
    const modules: readonly FirstPartyModule[] = [projectNotificationsModule]
    const composition = composeModules(modules)
    const control: ControlModuleServices = {
      projectionReader: asAsyncEventReadSurface(store),
      eventWriter: asAsyncEventWriter(store),
      onStored: store.onStored,
      publish: () => undefined,
      notify: async () => {},
      profileStore: { dbFile: join(directory, "account.sqlite"), reader: asAsyncEventReadSurface(account), writer: asAsyncEventWriter(account), onStored: account.onStored },
      authProfileId: () => "personal",
      onFrontendEvent: () => () => {},
    }
    const services = composeModuleProcessServices(modules, () => composition.enabledModuleIds, kernelPorts(control))
    services.reconcile()
    const notify = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, modules), () => services.services)
    const service = services.services.get(projectNotificationsService)

    services.closeAdmission()
    await notify(raise("runtime:auth-attention:stopping"))

    const visible = service && await list(service)
    await services.dispose()
    expect(visible?.map((episode) => episode.sourceId)).toEqual(["runtime:auth-attention:stopping"])

    await expect(notify(raise("runtime:auth-attention:late"))).rejects.toThrow("notification admission is closed")
  } finally {
    store.close()
    account.close()
  }
})
