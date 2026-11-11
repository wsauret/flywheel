import { Schema } from "effect";
import { fieldSchema } from "../output-contract/compile.js";
import { declaredPayload } from "../output-contract/leniency.js";
import { collectV1 } from "./collect.js";
import { coverageV1 } from "./coverage.js";
import { dedupeV1, dedupeV2 } from "./dedupe.js";
import { quorumV1 } from "./quorum.js";
import type { ReducerInput, ReducerOutput, ReducerParams, RegisteredReducer } from "./reducer.js";
import { topV1 } from "./top.js";

/** The registered deterministic reducers that a join can name. A
 *  behavior change registers a new version; an old version stays while
 *  stored runs can name it. */
const REDUCERS: readonly RegisteredReducer[] = [collectV1, coverageV1, dedupeV1, dedupeV2, topV1, quorumV1];

/** Every registered reducer as `<id>@<version>` with its parameters, for
 *  inspection. */
export const REGISTERED_REDUCERS: readonly Pick<RegisteredReducer, "id" | "version" | "parameters">[] = REDUCERS;

/** The ids of the reducers that count the votes of a phase with `votes`, as
 *  the refusal of another join over such a phase names them. */
export const VOTE_COUNTING_REDUCERS: readonly string[] = [...new Set(REDUCERS.filter(({ countsVotes }) => countsVotes).map(({ id }) => id))];

/** The latest version of a reducer id, or undefined when none is registered. */
export function latestReducer(id: string): RegisteredReducer | undefined {
  return REDUCERS.filter((reducer) => reducer.id === id).toSorted((left, right) => right.version - left.version)[0];
}

/** The reducer that a stored group names. A stored run can name only a
 *  registered version, so an unknown one is a broken invariant. */
export function requireReducer(id: string, version: number): RegisteredReducer {
  const reducer = REDUCERS.find((candidate) => candidate.id === id && candidate.version === version);
  if (!reducer) throw new Error(`Workflow invariant rejected unregistered reducer "${id}@${version}"`);
  return reducer;
}

/** Run one reducer and validate its output against the contract that
 *  compilation pinned on the group, so a reducer defect fails the fold
 *  instead of writing an artifact that a later phase reads wrongly. The
 *  check reads the declared keys only: an item that a reducer passes on can
 *  hold keys that its agent sent beside its contract, which the output
 *  boundary kept. */
export function runReducer(reducer: RegisteredReducer, params: ReducerParams, input: ReducerInput): ReducerOutput {
  const output = reducer.reduce(params, input);
  Schema.decodeUnknownSync(fieldSchema({ type: "object", fields: input.contract }))(declaredPayload(input.contract, output).payload);
  return output;
}
