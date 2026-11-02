import type { FrontendMutation, MutationResult, RuntimeClient, RuntimeQuery, RuntimeQueryResult } from "../../src/protocol/app-service-types.js";

type QueryType = RuntimeQuery["type"];
type Queries = { readonly [Type in QueryType]: Extract<RuntimeQuery, { readonly type: Type }> };
type QueryResults = { readonly [Type in QueryType]: RuntimeQueryResult<Queries[Type]> };

/** One scripted answer per query kind, typed as the runtime answers that kind. */
export type QueryAnswers = { readonly [Type in QueryType]?: (query: Queries[Type]) => QueryResults[Type] | Promise<QueryResults[Type]> };

/** An asynchronous answer to one query kind: the signature a test gives a
 *  mock that it rescripts with `mockImplementation` and its kin. */
export type QueryAnswer<Type extends QueryType> = (query: Queries[Type]) => Promise<QueryResults[Type]>;

/** The runtime client's generic query over answers scripted by kind, so each
 *  answer type-checks against the result of its own kind. A query of a kind
 *  with no answer goes to `otherwise`, or rejects with its kind named. A throw
 *  in an answer rejects the call. The answer's promise is returned as is,
 *  adding no promise turn, so a test that flushes a fixed number of turns
 *  still settles. */
export function runtimeQuery(answers: QueryAnswers, otherwise?: RuntimeClient["query"]): RuntimeClient["query"] {
  // The lookup by kind type-checks through a kind parameter that both the
  // request and its answer mention (TypeScript's correlated-union form).
  const answer = <Type extends QueryType>(type: Type, request: Queries[Type]) => {
    const scripted = answers[type];
    if (scripted !== undefined) return scripted(request);
    if (otherwise !== undefined) return otherwise(request);
    throw new Error(`No scripted answer for the ${type} query`);
  };
  function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>;
  function query(request: RuntimeQuery) {
    try {
      return Promise.resolve(answer(request.type, request));
    } catch (cause: unknown) {
      return Promise.reject(cause);
    }
  }
  return query;
}

/** Calls `record` with every query before `query` answers it, so a test can
 *  assert each query sent, whether or not any answer took it. */
export function recordedQuery(record: (request: RuntimeQuery) => void, query: RuntimeClient["query"]): RuntimeClient["query"] {
  return (request) => {
    record(request);
    return query(request);
  };
}

type MutationType = FrontendMutation["type"];
type Mutations = { readonly [Type in MutationType]: Extract<FrontendMutation, { readonly type: Type }> };
type MutationResults = { readonly [Type in MutationType]: MutationResult<Mutations[Type]> };

/** One scripted answer per mutation kind, typed as the runtime answers that kind. */
export type DispatchAnswers = { readonly [Type in MutationType]?: (command: Mutations[Type]) => MutationResults[Type] | Promise<MutationResults[Type]> };

/** An asynchronous answer to one mutation kind: the signature a test gives a
 *  mock that it rescripts with `mockResolvedValueOnce` and its kin. */
export type DispatchAnswer<Type extends MutationType> = (command: Mutations[Type]) => Promise<MutationResults[Type]>;

/** The runtime client's generic dispatch over answers scripted by kind, so
 *  each answer type-checks against the result of its own kind. A test records
 *  commands inside its answers, or through `recordedDispatch`. A command of a
 *  kind with no answer goes to `otherwise`, or rejects with its kind named. A
 *  throw in an answer rejects the call. The answer's promise is returned as
 *  is, adding no promise turn, so a test that flushes a fixed number of turns
 *  still settles. */
export function runtimeDispatch(answers: DispatchAnswers, otherwise?: RuntimeClient["dispatch"]): RuntimeClient["dispatch"] {
  const answer = <Type extends MutationType>(type: Type, command: Mutations[Type]) => {
    const scripted = answers[type];
    if (scripted !== undefined) return scripted(command);
    if (otherwise !== undefined) return otherwise(command);
    throw new Error(`No scripted answer for the ${type} mutation`);
  };
  function dispatch<C extends FrontendMutation>(command: C): Promise<MutationResult<C>>;
  function dispatch(command: FrontendMutation) {
    try {
      return Promise.resolve(answer(command.type, command));
    } catch (cause: unknown) {
      return Promise.reject(cause);
    }
  }
  return dispatch;
}

/** Calls `record` with every command before `dispatch` answers it, so a test
 *  can assert each command sent, whether or not any answer took it. */
export function recordedDispatch(record: (command: FrontendMutation) => void, dispatch: RuntimeClient["dispatch"]): RuntimeClient["dispatch"] {
  return (command) => {
    record(command);
    return dispatch(command);
  };
}
