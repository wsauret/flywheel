/**
 * The account service's report about itself, as a project serves it. The
 * report is account-wide, so the project's control facade answers it in the
 * snapshot from the account's one value and publishes each report it hears
 * on the `service` workspace domain (ARCH-PROTOCOL-025).
 */

import { expect, test } from "bun:test"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/account/projects/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/projections/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/runtime/app-service-types.js"
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

test("a client's restart readiness and restart reach the account service, never the executor", async () => {
  const f = fixture()
  const service = recordingAccountService()
  const client = createProjectControlClient({ ...f.options, service: service.port })

  expect(await client.query({ type: "restartReadiness" })).toEqual({ kind: "ready", serviceStart: "start-1" })
  expect(await client.dispatch({ type: "service.restart" })).toEqual({ ok: true })
  expect(service.restarts).toBe(1)

  const unavailable = { kind: "unavailable", reason: "nothing would start it", serviceStart: "start-1" } as const
  service.setReadiness(unavailable)
  expect(await client.query({ type: "restartReadiness" })).toEqual(unavailable)
  expect(await client.dispatch({ type: "service.restart" })).toEqual({ ok: false, error: "nothing would start it" })
  expect(service.restarts).toBe(1)

  await client.close()
  expect(f.failures).toEqual([])
})
