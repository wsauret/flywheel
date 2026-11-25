/**
 * A person's restart of the account service from a web client
 * (PI-INTERACTION-048): the service answers once its replacement owner holds
 * the request and before it makes way, and refuses, stopping nothing, while
 * nothing would start it again or the request could not be accepted.
 */

import { expect, test } from "bun:test"
import { createReplacementOwner } from "../../../../../src/orchestration/app-service/account/replacement-owner.js"
import { createServiceRestart } from "../../../../../src/orchestration/app-service/account/service-restart.js"
import { RESTART_NO_STARTER_REASON, RESTART_UNCHECKED_REASON } from "../../../../../src/protocol/client/runtime/service-restart-copy.js"

function harness(refusal: string | undefined, blockers: () => Promise<readonly []> = async () => []) {
  const events: string[] = []
  const replacement = createReplacementOwner({
    blockers: async () => { events.push("blockers read"); return blockers() },
    handOff: async () => { events.push("handed off") },
    retire: () => { events.push("retired") },
  })
  const restart = createServiceRestart({ lane: "dev", refusal: () => refusal, replacement })
  return { events, replacement, restart }
}

test("a restart with a starter is answered once the drain begins and before the service retires", async () => {
  const { events, replacement, restart } = harness(undefined)
  expect(restart.restartReadiness()).toEqual({ kind: "ready", serviceStart: expect.any(String) })

  expect(await restart.restart()).toEqual({ ok: true })
  events.push("answered")
  await Bun.sleep(5)

  expect(events).toEqual(["blockers read", "handed off", "answered", "retired"])
  expect(replacement.state).toMatchObject({ kind: "draining" })
  replacement.dispose()
})

test("a restart with no starter is refused with the reason and stops nothing", async () => {
  const { events, replacement, restart } = harness(RESTART_NO_STARTER_REASON)
  const readiness = restart.restartReadiness()
  expect(readiness).toEqual({ kind: "unavailable", reason: RESTART_NO_STARTER_REASON, serviceStart: expect.any(String) })

  expect(await restart.restart()).toEqual({ ok: false, error: RESTART_NO_STARTER_REASON })
  await Bun.sleep(5)

  expect(events).toEqual([])
  expect(replacement.state).toEqual({ kind: "none" })
  // The same start answers again, so a client tells it from a successor.
  expect(restart.restartReadiness().serviceStart).toBe(readiness.serviceStart)
  replacement.dispose()
})

test("a restart whose blockers cannot be read is refused, and the service keeps serving", async () => {
  const { events, replacement, restart } = harness(undefined, async () => { throw new Error("the registry could not be read") })

  expect(await restart.restart()).toEqual({ ok: false, error: RESTART_UNCHECKED_REASON })
  await Bun.sleep(5)

  expect(events).toEqual(["blockers read"])
  expect(replacement.state).toEqual({ kind: "none" })
  replacement.dispose()
})
