import type { AsyncEventStateReadSurface, FactQuery } from "../../src/infra/event-store-types.js"

/** One durable request a reader made: the surface method, the aggregate or
 *  query it named, and how many facts it returned once it settled. */
export interface StateRequest {
  readonly method: string
  readonly aggregateId: string | undefined
  readonly query: FactQuery | undefined
  /** Every argument of the call, such as the lower position of a page read. */
  readonly args: readonly unknown[]
  facts: number
}

export interface StateRequestCounter<Reader extends object = AsyncEventStateReadSurface> {
  /** The counted surface. Pass it where the code under test reads. */
  readonly reader: Reader
  /** The requests made since the last `take`, which it clears. */
  take(): StateRequest[]
}

function isQuery(value: unknown): value is FactQuery {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Records every method call on `reader`. A work-count test measures the
 *  requests, or the facts they return, that one change costs, and asserts
 *  that the cost does not grow with the member count or the history length:
 *
 *    const counter = countStateRequests(reader)
 *    await owner.replay()            // the first fold may read in full
 *    counter.take()
 *    append(oneChange)
 *    await owner.replay()
 *    expect(counter.take().length).toBe(...)  // the same for 3 and 30 members */
export function countStateRequests<Reader extends object = AsyncEventStateReadSurface>(reader: Reader): StateRequestCounter<Reader> {
  let requests: StateRequest[] = []
  const counted = new Proxy(reader, {
    get(target, method) {
      const member: unknown = Reflect.get(target, method)
      if (typeof method !== "string" || typeof member !== "function") return member
      return (...args: unknown[]) => {
        const [first] = args
        const query = isQuery(first) ? first : undefined
        const request: StateRequest = { method, aggregateId: typeof first === "string" ? first : query?.aggregateId, query, args, facts: 0 }
        requests.push(request)
        const result: unknown = member.apply(target, args)
        if (!(result instanceof Promise)) return result
        return result.then((value: unknown) => {
          const facts = typeof value === "object" && value !== null && "facts" in value ? value.facts : undefined
          if (Array.isArray(facts)) request.facts = facts.length
          return value
        })
      }
    },
  })
  return {
    reader: counted,
    take() {
      const taken = requests
      requests = []
      return taken
    },
  }
}

/** The facts a set of requests returned, which is what a rebuilt fold pays for. */
export function factsRead(requests: readonly StateRequest[]): number {
  return requests.reduce((total, request) => total + request.facts, 0)
}
