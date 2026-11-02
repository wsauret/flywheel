import { describe, expect, test } from "bun:test"
import type { ContainerProcessor } from "../../../../src/infra/container-processor.js"
import { createProcessorGovernor, type ProcessorClaims, type ProcessorHolds } from "../../../../src/orchestration/app-service/processor-governor.js"

/** Containers with a set number of runnable threads while they run and none
 *  while held, and a timer the test fires one tick at a time. */
function harness(options: { readonly budget: number; readonly holdFails?: ReadonlySet<string> }) {
  const cores = new Map<string, number>()
  const stopped = new Set<string>()
  const holds: string[] = []
  const releases: string[] = []
  const continued: string[] = []
  const sampled: string[][] = []
  let tick: (() => void) | undefined
  let cancels = 0
  const processor: ContainerProcessor = {
    demand(refs) {
      sampled.push(refs.map((ref) => ref.token))
      return new Map(refs.map((ref) => [ref.token, stopped.has(ref.token) ? 0 : cores.get(ref.token) ?? 0]))
    },
    hold(ref) {
      if (options.holdFails?.has(ref.token)) return false
      holds.push(ref.token)
      stopped.add(ref.token)
      return true
    },
    release(ref) {
      continued.push(ref.token)
      if (stopped.delete(ref.token)) releases.push(ref.token)
    },
  }
  const governor = createProcessorGovernor({
    processor,
    budget: options.budget,
    clock: {
      every(run) {
        tick = run
        return () => { cancels += 1; tick = undefined }
      },
    },
  })
  const executor = (projectId: string, generation = 1) => {
    const sent: ProcessorHolds[] = []
    const member = governor.join({ projectId, generation, send: (held) => sent.push(held) })
    return { member, sent }
  }
  return {
    governor, executor, holds, releases, continued, sampled, stopped,
    use(token: string, value: number) { cores.set(token, value) },
    /** One second passes and the governor ticks. A container counts from
     *  its second reading. */
    advance() {
      tick?.()
    },
    ticking: () => tick !== undefined,
    cancels: () => cancels,
  }
}

const claim = (token: string, order: number, exempt = false): ProcessorClaims[number] => ({ token, pid: 100 + order, order, exempt })

describe("processor governor", () => {
  test("holds the newest heavy container once measured demand exceeds the budget", () => {
    const h = harness({ budget: 4 })
    const { member, sent } = h.executor("p")
    for (const token of ["a", "b", "c"]) h.use(token, 2)
    member.claim([claim("a", 1), claim("b", 2), claim("c", 3)])
    h.advance()
    // One reading proves nothing about a container, so nothing is held yet.
    expect(h.holds).toEqual([])
    h.advance()
    expect(h.holds).toEqual(["c"])
    expect(sent).toEqual([[{ token: "c", ahead: 0 }]])
    member.resend()
    expect(sent.at(-1)).toEqual([{ token: "c", ahead: 0 }])
  })

  test("a held container keeps its demand and the oldest held one is released first", () => {
    const h = harness({ budget: 2 })
    const { member, sent } = h.executor("p")
    for (const token of ["a", "b", "c"]) h.use(token, 2)
    member.claim([claim("a", 1), claim("b", 2), claim("c", 3)])
    h.advance()
    h.advance()
    expect(h.holds).toEqual(["b", "c"])
    expect(sent.at(-1)).toEqual([{ token: "b", ahead: 0 }, { token: "c", ahead: 1 }])
    // Held containers measure zero, yet their demand keeps them held.
    h.advance()
    expect(h.releases).toEqual([])
    // The oldest exits: its budget goes to the oldest held container only.
    member.claim([claim("b", 2), claim("c", 3)])
    h.advance()
    expect(h.releases).toEqual(["b"])
    expect(sent.at(-1)).toEqual([{ token: "c", ahead: 0 }])
  })

  test("never holds an exempt container, and the oldest heavy container runs even when exempt use fills the budget", () => {
    const h = harness({ budget: 2 })
    const { member, sent } = h.executor("p")
    h.use("chat", 6)
    h.use("a", 2)
    h.use("b", 2)
    member.claim([claim("chat", 3, true), claim("a", 1), claim("b", 2)])
    h.advance()
    h.advance()
    expect(h.holds).toEqual(["b"])
    expect(sent.at(-1)).toEqual([{ token: "b", ahead: 0 }])
  })

  test("a light container is never held", () => {
    const h = harness({ budget: 1 })
    const { member } = h.executor("p")
    h.use("a", 2)
    h.use("grep", 0.1)
    member.claim([claim("a", 1), claim("grep", 2)])
    h.advance()
    h.advance()
    expect(h.holds).toEqual([])
  })

  test("a short command caught at one tick is not held", () => {
    const h = harness({ budget: 1 })
    const { member } = h.executor("p")
    h.use("a", 2)
    h.use("rg", 1)
    member.claim([claim("a", 1), claim("rg", 2)])
    h.advance()
    // The next tick finds it ended.
    member.claim([claim("a", 1)])
    h.advance()
    expect(h.holds).toEqual([])
  })

  test("a container new to the governor is continued once, in case a governor that ended left it stopped", () => {
    const h = harness({ budget: 8 })
    const { member } = h.executor("p")
    member.claim([claim("a", 1)])
    member.claim([claim("a", 1), claim("b", 2)])
    expect(h.continued).toEqual(["a", "b"])
  })

  test("a held container whose claim disappears is continued at once", () => {
    const h = harness({ budget: 2 })
    const { member, sent } = h.executor("p")
    h.use("a", 2)
    h.use("b", 2)
    member.claim([claim("a", 1), claim("b", 2)])
    h.advance()
    h.advance()
    expect(h.holds).toEqual(["b"])
    member.claim([claim("a", 1)])
    expect(h.releases).toEqual(["b"])
    expect(sent.at(-1)).toEqual([])
  })

  test("a container that another generation still claims stays held when one generation drops it", () => {
    const h = harness({ budget: 2 })
    const old = h.executor("p", 1)
    const next = h.executor("p", 2)
    h.use("a", 2)
    h.use("b", 2)
    old.member.claim([claim("a", 1), claim("b", 2)])
    h.advance()
    h.advance()
    next.member.claim([claim("b", 2)])
    expect(next.sent.at(-1)).toEqual([{ token: "b", ahead: 0 }])
    old.member.leave()
    // The old generation's own container is continued; the handed-over one is not.
    expect(h.releases).toEqual([])
    expect(next.sent.at(-1)).toEqual([{ token: "b", ahead: 0 }])
  })

  test("a closed generation's containers are continued and the timer stops", () => {
    const h = harness({ budget: 2 })
    const { member } = h.executor("p")
    for (const token of ["a", "b", "c"]) h.use(token, 2)
    member.claim([claim("a", 1), claim("b", 2), claim("c", 3)])
    h.advance()
    h.advance()
    member.leave()
    expect(h.releases.toSorted()).toEqual(["b", "c"])
    expect(h.ticking()).toBe(false)
    // A late report from the ended generation changes nothing.
    member.claim([claim("d", 4)])
    expect(h.ticking()).toBe(false)
  })

  test("each generation hears its complete held set with ahead counted across every project", () => {
    const h = harness({ budget: 2 })
    const p = h.executor("p")
    const q = h.executor("q")
    for (const token of ["p1", "q1", "p2", "q2"]) h.use(token, 2)
    p.member.claim([claim("p1", 1), claim("p2", 3)])
    q.member.claim([claim("q1", 2), claim("q2", 4)])
    h.advance()
    h.advance()
    expect(p.sent.at(-1)).toEqual([{ token: "p2", ahead: 1 }])
    expect(q.sent.at(-1)).toEqual([{ token: "q1", ahead: 0 }, { token: "q2", ahead: 2 }])
    // p1 exits: q1 is released, and p2 and q2 each have one fewer ahead.
    p.member.claim([claim("p2", 3)])
    h.advance()
    expect(h.releases).toEqual(["q1"])
    expect(p.sent.at(-1)).toEqual([{ token: "p2", ahead: 0 }])
    expect(q.sent.at(-1)).toEqual([{ token: "q2", ahead: 1 }])
  })

  test("a failed hold leaves the container running and unreported", () => {
    const h = harness({ budget: 2, holdFails: new Set(["b"]) })
    const { member, sent } = h.executor("p")
    h.use("a", 2)
    h.use("b", 2)
    member.claim([claim("a", 1), claim("b", 2)])
    h.advance()
    h.advance()
    h.advance()
    expect(h.holds).toEqual([])
    expect(sent).toEqual([])
    // Ends the failure episode, whose window timer would otherwise outlive the test.
    h.governor.dispose()
  })

  test("one tick samples every claimed container once, however many generations report", () => {
    const h = harness({ budget: 64 })
    const generations = Array.from({ length: 8 }, (_, index) => h.executor(`p${index}`))
    for (const [index, { member }] of generations.entries()) member.claim([claim(`c${index}`, index), claim(`d${index}`, index + 100)])
    h.advance()
    expect(h.sampled).toHaveLength(1)
    expect(h.sampled[0]).toHaveLength(16)
  })

  test("dispose continues every held container", () => {
    const h = harness({ budget: 2 })
    const { member } = h.executor("p")
    for (const token of ["a", "b", "c"]) h.use(token, 2)
    member.claim([claim("a", 1), claim("b", 2), claim("c", 3)])
    h.advance()
    h.advance()
    h.governor.dispose()
    expect(h.releases.toSorted()).toEqual(["b", "c"])
    expect(h.ticking()).toBe(false)
  })
})
