import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"

import type { ProviderDemand } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { sessionEngineDemand } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-demand.js"
import { createEngineRegistry, type EnginePlace } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-registry.js"
import { releaseLiveEngines } from "../../../../../src/orchestration/modules/provider-google-antigravity/live-engines.js"
import { fakeLaunches, settle, tool } from "./_fake-engine.js"

const PLACE: EnginePlace = { treeRootSessionId: "A", loginDir: "/login-1", accountId: "one", tools: [tool("read")] }

/** One show of a session, which counts the plans it was asked for. */
function shownSession() {
  const scope = Effect.runSync(Scope.make())
  let stale = 0
  const demand: ProviderDemand = { scope, stale: () => { stale += 1 } }
  return { demand, staleCount: () => stale, hide: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

function setup() {
  const launches = fakeLaunches()
  const registry = createEngineRegistry(launches.launch)
  const session = shownSession()
  const demand = sessionEngineDemand(session.demand)
  const claim = () => demand.claimEngine("A@login-1", () => registry.lease(PLACE))
  return { ...launches, registry, session, claim }
}

describe("a session's engine demand", () => {
  test("the first claim on a place launches its engine ahead of the request, and every role on the place shares it", async () => {
    const { engines, claim, registry, session } = setup()
    const chat = claim()
    const role = claim()
    await settle()
    expect(engines.map(({ processId }) => processId)).toEqual(["p1"])
    await chat.release()
    expect(engines[0]?.exited).toBe(false)
    await role.release()
    expect(engines[0]?.exited).toBe(true)
    await session.hide()
    await registry.drain()
  })

  test("a role moved to a selection on the same place claims before it releases, so the engine never closes between them", async () => {
    const { engines, claim, registry, session } = setup()
    const old = claim()
    await settle()
    const moved = claim()
    await old.release()
    expect(engines.map(({ exited }) => exited)).toEqual([false])
    await moved.release()
    await session.hide()
    await registry.drain()
  })

  test("an engine that served asks for one plan when it ends; one that never served stays silent", async () => {
    const { engines, claim, registry, session, failNextLaunch } = setup()
    claim()
    await settle()
    engines[0]?.end(false)
    await settle()
    expect(session.staleCount()).toBe(0)
    failNextLaunch(new Error("launch failed"))
    claim()
    await settle()
    expect(session.staleCount()).toBe(0)
    claim()
    await settle()
    engines[1]?.end(true)
    await settle()
    expect(session.staleCount()).toBe(1)
    await session.hide()
    await registry.drain()
  })

  test("the module turned off releases an idle engine at once, and one with an open prompt after the prompt settles", async () => {
    const { engines, claim, registry, session } = setup()
    claim()
    await settle()
    releaseLiveEngines()
    await settle()
    expect(engines[0]?.exited).toBe(true)
    expect(session.staleCount()).toBe(1)

    claim()
    await settle()
    const settlePrompt = engines[1]?.openPrompt()
    releaseLiveEngines()
    await settle()
    expect(engines[1]?.exited).toBe(false)
    settlePrompt?.()
    await settle()
    expect(engines[1]?.exited).toBe(true)
    await session.hide()
    await registry.drain()
  })

  test("hiding the session releases what its claims still hold", async () => {
    const { engines, claim, registry, session } = setup()
    claim()
    await settle()
    await session.hide()
    expect(engines[0]?.exited).toBe(true)
    await registry.drain()
  })
})
