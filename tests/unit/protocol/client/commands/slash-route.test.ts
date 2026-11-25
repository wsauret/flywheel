import { describe, expect, it, jest } from "bun:test"
import { routeSlashToken, type CommandCatalogReadiness } from "../../../../../src/protocol/client/commands/slash-route.js"
import { runtimeCallPolicies } from "../../../../../src/protocol/rpc/runtime-client-deadlines.js"

/** A client's catalog intake: nothing until `arrive` publishes the owners. */
function catalog(initial: readonly string[] | undefined) {
  let owners = initial
  const arrival = Promise.withResolvers<void>()
  const readiness: CommandCatalogReadiness = { known: () => owners !== undefined, arrived: arrival.promise }
  return {
    readiness,
    route: (token: string) => () => owners?.includes(token) || token === "new" ? token : undefined,
    arrive(published: readonly string[]) { owners = published; arrival.resolve() },
  }
}

describe("routeSlashToken", () => {
  it("waits at most as long as the command catalog read itself", async () => {
    jest.useFakeTimers()
    try {
      const early = catalog(undefined)
      const routing = routeSlashToken(early.readiness, early.route("doctor"))
      if (routing.kind !== "waiting") throw new Error(`expected a wait, got ${routing.kind}`)
      let settled = false
      void routing.settled.finally(() => { settled = true })
      jest.advanceTimersByTime(runtimeCallPolicies.commandCatalog.deadlineMs - 1)
      await Promise.resolve()
      expect(settled).toBe(false)
      jest.advanceTimersByTime(1)
      expect(await routing.settled).toEqual({ kind: "loading", notice: "Commands are still loading; your command stays in the prompt" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("routes a token the client already owns at once, even before the catalog arrives", () => {
    const early = catalog(undefined)
    expect(routeSlashToken(early.readiness, early.route("new"))).toEqual({ kind: "routed", route: "new" })
  })

  it("answers an unowned token at once when the catalog is known", () => {
    const known = catalog(["doctor"])
    expect(routeSlashToken(known.readiness, known.route("nope"))).toEqual({ kind: "unowned" })
  })

  it("routes a token typed before the catalog once the catalog that owns it arrives", async () => {
    const early = catalog(undefined)
    const routing = routeSlashToken(early.readiness, early.route("doctor"))
    if (routing.kind !== "waiting") throw new Error(`expected a wait, got ${routing.kind}`)
    early.arrive(["doctor"])
    expect(await routing.settled).toEqual({ kind: "routed", route: "doctor" })
  })

  it("calls a token unowned only once the catalog is known", async () => {
    const early = catalog(undefined)
    const routing = routeSlashToken(early.readiness, early.route("nope"))
    if (routing.kind !== "waiting") throw new Error(`expected a wait, got ${routing.kind}`)
    early.arrive(["doctor"])
    expect(await routing.settled).toEqual({ kind: "unowned" })
  })

  it("keeps the command with the loading notice when the catalog does not arrive in time", async () => {
    const early = catalog(undefined)
    const routing = routeSlashToken(early.readiness, early.route("doctor"), 5)
    if (routing.kind !== "waiting") throw new Error(`expected a wait, got ${routing.kind}`)
    expect(await routing.settled).toEqual({ kind: "loading", notice: "Commands are still loading; your command stays in the prompt" })
  })
})
