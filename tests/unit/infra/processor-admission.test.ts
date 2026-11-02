import { describe, expect, it } from "bun:test"

import { heldContainers, type ProcessorClaim } from "../../../src/infra/processor-admission.js"

function claim(id: string, order: number, cores: number, extra: Partial<ProcessorClaim> = {}): ProcessorClaim {
  return { id, order, cores, exempt: false, ...extra }
}

describe("processor admission", () => {
  it("holds nothing while heavy demand fits the budget", () => {
    expect([...heldContainers([claim("a", 1, 4), claim("b", 2, 4)], 11)]).toEqual([])
  })

  it("admits oldest first while budget remains and holds every newer heavy container", () => {
    const claims = [claim("d", 4, 4), claim("b", 2, 4), claim("a", 1, 4), claim("c", 3, 4), claim("e", 5, 4)]
    // a, b, c start with 0, 4, and 8 cores in use, all under 11; d starts at 12.
    expect([...heldContainers(claims, 11)].sort()).toEqual(["d", "e"])
  })

  it("keeps first-in-first-out order: a smaller newer container never passes a held older one", () => {
    const claims = [claim("a", 1, 10), claim("b", 2, 4), claim("c", 3, 1)]
    expect([...heldContainers(claims, 11)].sort()).toEqual(["c"])
    const crowded = [claim("a", 1, 12), claim("b", 2, 6), claim("c", 3, 1)]
    expect([...heldContainers(crowded, 11)].sort()).toEqual(["b", "c"])
  })

  it("always runs the oldest heavy container, even when exempt work fills the budget", () => {
    const claims = [claim("chat", 5, 12, { exempt: true }), claim("a", 1, 4), claim("b", 2, 4)]
    expect([...heldContainers(claims, 11)]).toEqual(["b"])
  })

  it("never holds an exempt container and counts its use against the budget", () => {
    const claims = [claim("chat", 9, 8, { exempt: true }), claim("a", 1, 2), claim("b", 2, 4)]
    // The chat uses 8; a starts at 8 and b starts at 10, both under 11.
    expect([...heldContainers(claims, 11)]).toEqual([])
    const fuller = [claim("chat", 9, 9, { exempt: true }), claim("a", 1, 2), claim("b", 2, 4)]
    expect([...heldContainers(fuller, 11)]).toEqual(["b"])
  })

  it("never holds a light container and does not count it", () => {
    const claims = [claim("a", 1, 12), claim("ls", 2, 0.1), claim("b", 3, 4)]
    expect([...heldContainers(claims, 11)]).toEqual(["b"])
  })
})
