import { expect, test } from "bun:test"
import { join } from "node:path"

import { composeModules } from "../../../../../src/infra/definitions/module-descriptor.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/substrate/events/notification-episode.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/substrate/store/event-store-types.js"
import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { composeModuleProcessServices, createNotifySeam } from "../../../../../src/orchestration/app-service/executor/execution/module-service-host.js"
import type { ControlModuleServices } from "../../../../../src/orchestration/app-service/account/projects/account-module-services.js"
import { composeRealmModuleSnapshot } from "../../../../../src/orchestration/module-contract/module-composition.js"
import type { FirstPartyModule } from "../../../../../src/orchestration/module-contract/module-catalog.js"
import { projectNotificationsModule } from "../../../../../src/orchestration/modules/project-notifications/module.js"
import { projectNotificationsService } from "../../../../../src/orchestration/modules/project-notifications/service.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { kernelPorts } from "../../../../helpers/module-kernel.js"

const tempDir = temporaryDirectories()
const raise = (sourceId: string): NotificationEpisodeInput => ({
  type: "raise",
  occurrence: { sourceId, title: "Authentication needed", message: "Sign in.", severity: "warning", action: { kind: "open-auth" } },
})

// A composition that owns the service itself closes every service's admission
// when shutdown begins, then stops its runners, then disposes the services in
// the durable flush. Runners that stop still state their conditions, so the
// sink must take them until that flush, as the account's sink does for an
// executor that stops before the account settles it.
test("the sink takes a producer's episode after shutdown begins and refuses one after the durable flush", async () => {
  const store = createSqliteEventStore(join(tempDir("notification-service-"), "events.sqlite"))
  try {
    const modules: readonly FirstPartyModule[] = [projectNotificationsModule]
    const composition = composeModules(modules)
    const control: ControlModuleServices = {
      projectionReader: asAsyncEventReadSurface(store),
      eventWriter: asAsyncEventWriter(store),
      onStored: store.onStored,
      publish: () => undefined,
      notify: async () => {},
    }
    const services = composeModuleProcessServices(modules, () => composition.enabledModuleIds, kernelPorts(control))
    services.reconcile()
    const notify = createNotifySeam(() => composeRealmModuleSnapshot({ moduleIds: composition.enabledModuleIds }, modules), () => services.services)
    const journal = services.services.get(projectNotificationsService)?.journal

    services.closeAdmission()
    await notify(raise("runtime:auth-attention:stopping"))

    await services.dispose()
    expect(journal?.projection().episodes.map((episode) => episode.sourceId)).toEqual(["runtime:auth-attention:stopping"])

    await expect(notify(raise("runtime:auth-attention:late"))).rejects.toThrow("notification admission is closed")
  } finally {
    store.close()
  }
})
