import { describe, expect, it } from "bun:test"
import { COMMAND_CATALOG_WAIT_MS, routeSlashToken, type CommandCatalogReadiness } from "../../../../src/protocol/client/slash-route.js"
import { runtimeCallPolicies } from "../../../../src/protocol/runtime-client-deadlines.js"

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
  it("waits at most as long as the command catalog read itself", () => {
    const policy = runtimeCallPolicies.commandCatalog
    expect(policy._tag === "BestEffort" ? policy.deadlineMs : undefined).toBe(COMMAND_CATALOG_WAIT_MS)
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
