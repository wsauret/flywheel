import { readJsonValue } from "../../infra/llm/json-parse.js";
import { isRecord, type UnknownRecord } from "../../infra/record.js";
import { acceptAgentOutput, type OutputAcceptance } from "../../workflows/output-contract/accept.js";
import { objectJsonSchema, type CompiledOutput, type JsonSchema } from "../../workflows/output-contract/compile.js";
import type { ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";
import { withoutEmptyOptionals } from "../../workflows/output-contract/leniency.js";
import type { OutputIssue } from "../../workflows/output-contract/paths.js";
import { coerceToolInput } from "../agent-runtime/tools/coerce-input.js";
import { createOutputAcceptContext } from "./output-accept-context.js";

/** What one handoff call can reach when it accepts a submission. */
interface HandoffAcceptContext {
  readonly executionCwd: string;
  readonly readCommandEvidence?: ReadCommandEvidence;
  /** The submitting agent's scratchpad, which holds a `submit: file` output. */
  readonly scratchDir?: string;
}

/** The handoff tool's contract. Orchestration owns this type because only
 *  runtime tool wiring consumes it; workflows/ never sees it. */
export interface HandoffToolSchema {
  /** The provider tool input schema. Its root is one `type: "object"`, and
   *  its `required` keys are checked before anything else runs. */
  readonly input: JsonSchema;
  /** Turns a submission into the stored payload, or into one report of every
   *  problem. Absent for a handoff that has no output contract, such as a
   *  subagent's result, which is accepted as submitted. */
  readonly accept?: (submission: UnknownRecord, context: HandoffAcceptContext) => Promise<OutputAcceptance>;
}

/** A handoff that the tool refused: the submission after every repair the
 *  tool made, and every problem that remains. `payload` is absent when a
 *  `submit: file` output could not be read. */
export interface HandoffRejection {
  readonly payload?: UnknownRecord;
  readonly issues: readonly OutputIssue[];
}

/** A refused handoff as its owner delivers it when the agent's handoff
 *  correction runs out, so a formatting error never throws the work away. */
export interface DeliveredHandoff {
  readonly payload: UnknownRecord;
  readonly issues: readonly OutputIssue[];
}

/** The refused handoffs of one run, which its owner keeps. */
export interface RefusedHandoff {
  /** Keeps `rejection` as the latest refusal, unless it holds no payload
   *  and an earlier one does: a submission that could be read holds more
   *  of the agent's work than a file that could not. */
  readonly record: (rejection: HandoffRejection) => void;
  /** The handoff to deliver, or undefined when the tool refused none. A
   *  refusal with no payload delivers an empty payload, and its issues name
   *  the file that could not be read. */
  readonly delivered: () => DeliveredHandoff | undefined;
}

export function createRefusedHandoff(): RefusedHandoff {
  let latest: HandoffRejection | undefined;
  return {
    record(rejection) {
      if (rejection.payload !== undefined || latest?.payload === undefined) latest = rejection;
    },
    delivered: () => latest === undefined ? undefined : { payload: latest.payload ?? {}, issues: latest.issues },
  };
}

/** A list value as delivery reads it: a list sent as one object, or as JSON
 *  text that holds one object or a list, becomes a list. Undefined for any
 *  other value, which stays as it is. */
function asList(value: unknown): readonly unknown[] | undefined {
  const parsed = typeof value === "string" ? readJsonValue(value)?.value : value;
  if (isRecord(parsed)) return [parsed];
  return Array.isArray(parsed) ? parsed : undefined;
}

/** A refused payload with every repair whose meaning is clear, which a
 *  delivery can use but the strict correction does not make: a list sent as
 *  one item or as JSON text becomes a list, each value converts as the
 *  dispatcher converts a tool argument (numeric text, JSON text, a scalar
 *  for a list of scalars), and each empty optional string is absent. A
 *  `submit: file` output, which the dispatcher never converts, gets the
 *  same repairs. */
function deliverablePayload(output: CompiledOutput, payload: UnknownRecord): UnknownRecord {
  const listed = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, output.payloadFields[key]?.type === "list" ? asList(value) ?? value : value]));
  const converted = coerceToolInput(listed, objectJsonSchema(output.payloadFields));
  return withoutEmptyOptionals(output.payloadFields, converted).payload;
}

/** The handoff tool of one agent of a workflow, from the agent's compiled
 *  output. A refused submission carries its deliverable payload, so its
 *  owner delivers the repaired work when correction runs out. */
export function handoffToolSchemaFromOutput(output: CompiledOutput): HandoffToolSchema {
  return {
    input: output.toolInput,
    async accept(submission, context) {
      const accepted = await acceptAgentOutput(output, submission, createOutputAcceptContext(context.executionCwd, context.scratchDir, context.readCommandEvidence));
      return accepted.ok || accepted.payload === undefined ? accepted : { ...accepted, payload: deliverablePayload(output, accepted.payload) };
    },
  };
}
