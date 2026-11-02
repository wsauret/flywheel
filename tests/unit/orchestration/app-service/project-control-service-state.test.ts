/**
 * The account service's report about itself, as a project serves it. The
 * report is account-wide, so the project's control facade answers it in the
 * snapshot from the account's one value and publishes each report it hears
 * on the `service` workspace domain (ARCH-PROTOCOL-025).
 */

import { expect, test } from "bun:test"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { recordingAccountService } from "../../../helpers/account-service-state.js"
import { fixture } from "./_project-control-client-fixture.js"

test("the snapshot answers the account service's report, each report reaches the project's clients, and a closed project stops hearing it", async () => {
  const f = fixture()
  const service = recordingAccountService()
  const bus = createRuntimeUiBus()
  const client = createProjectControlClient({ ...f.options, bus, service: service.port })
  const events: FrontendEvent[] = []
  client.subscribe((event) => events.push(event))
  const crashLoop = { kind: "crash_loop", cause: "the hub stopped" } as const

  expect((await client.query({ type: "snapshot" })).service).toEqual({ kind: "serving" })
  service.report(crashLoop)
  expect((await client.query({ type: "snapshot" })).service).toEqual(crashLoop)
  service.report({ kind: "serving" })
  await bus.drain()
  const published = events.flatMap((event) => event.type === "patch" && event.patch.payload.kind === "service.changed" ? [{ cursor: event.patch.cursor, service: event.patch.payload.service }] : [])
  expect(published).toEqual([
    { cursor: { scope: "workspace", domain: "service" }, service: crashLoop },
    { cursor: { scope: "workspace", domain: "service" }, service: { kind: "serving" } },
  ])

  await client.close()
  expect(service.listeners.size).toBe(0)
  expect(f.failures).toEqual([])
  await bus.clear()
})
