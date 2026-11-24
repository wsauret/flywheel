import type { FrontendMutation, MutationResult, RuntimeQuery } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"
import { recordedQuery, runtimeQuery, type DispatchAnswers, type QueryAnswers } from "../../../tests/helpers/runtime-dispatch.js"

/** A typed fake of the runtime connection for client fixtures. It answers
 *  only the query and mutation kinds a fixture scripts and throws for every
 *  other call, so a fixture that reaches past its script fails by name
 *  instead of reading an invented shape. It imports no client component, so
 *  a fixture outside the webview's JSX project can use it. */

type MutationType = FrontendMutation["type"]
type Mutations = { readonly [Type in MutationType]: Extract<FrontendMutation, { readonly type: Type }> }
type MutationResults = { readonly [Type in MutationType]: MutationResult<Mutations[Type]> }
/** `DispatchAnswers` as a mapped type over this file's kind map, which the correlated lookup below needs. */
type HeldAnswers = { readonly [Type in MutationType]?: (mutation: Mutations[Type]) => MutationResults[Type] | Promise<MutationResults[Type]> }

export interface FakeConnectionScript {
  readonly queries?: QueryAnswers
  readonly mutations?: DispatchAnswers
  /** Hears every query before its answer, such as to count reads. */
  readonly onQuery?: (query: RuntimeQuery) => void
  /** Hears every mutation before its answer; the answer waits for a returned promise, as a write in flight over a slow link does. */
  readonly onDispatch?: (mutation: FrontendMutation) => void | Promise<void>
}

/** `answer`'s result as a promise, rejected when `answer` throws. */
function settled<Result>(answer: () => Result | Promise<Result>): Promise<Result> {
  try {
    return Promise.resolve(answer())
  } catch (cause: unknown) {
    return Promise.reject(cause)
  }
}

const unused = (member: string) => (): never => {
  throw new Error(`The fake connection has no ${member}`)
}

/** A connection whose lane is open and healthy, that answers `script`, and
 *  whose other members `members` replaces. Lanes come from `fakeLanes`, so a
 *  fixture that drives lanes passes its own `onLane` and `watchOutput`. */
export function fakeRuntimeConnection(script: FakeConnectionScript = {}, members: Partial<Omit<RuntimeConnection, "query" | "dispatch">> = {}): RuntimeConnection {
  const query = recordedQuery((request) => { script.onQuery?.(request) }, runtimeQuery(script.queries ?? {}))
  const mutations: HeldAnswers = script.mutations ?? {}
  // The lookup by kind type-checks through a kind parameter that both the
  // request and its answer mention (TypeScript's correlated-union form). It
  // returns the raw answer, so a held mutation adopts no second promise and
  // settles in the turns a fixture that flushes after its hold counts on.
  const answerMutation = <Type extends MutationType>(type: Type, mutation: Mutations[Type]) => {
    const answer = mutations[type]
    if (answer === undefined) throw new Error(`No scripted answer for the ${type} mutation`)
    return answer(mutation)
  }
  // Each call settles as soon as its answer does, with no turn of its own,
  // so a fixture that counts turns waits for the answer alone.
  function dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  function dispatch(mutation: FrontendMutation) {
    const heard = script.onDispatch?.(mutation)
    return heard === undefined ? settled(() => answerMutation(mutation.type, mutation)) : heard.then(() => answerMutation(mutation.type, mutation))
  }
  return {
    state: "connected",
    health: { kind: "healthy" },
    ...fakeLanes().client,
    subscribe: () => () => {},
    onStateChange: () => () => {},
    onHealthChange: () => () => {},
    reportDiagnostic: () => {},
    ready: async () => {},
    close: async () => {},
    fault: unused("fault"),
    reconnect: unused("reconnect"),
    resume: unused("resume"),
    appeared: unused("appeared"),
    ...members,
    query,
    dispatch,
  }
}
