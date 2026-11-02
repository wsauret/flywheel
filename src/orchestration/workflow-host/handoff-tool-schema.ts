import type { UnknownRecord } from "../../infra/record.js";
import { acceptAgentOutput, type OutputAcceptance } from "../../workflows/output-contract/accept.js";
import type { CompiledOutput, JsonSchema } from "../../workflows/output-contract/compile.js";
import type { ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";
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

/** The handoff tool of one agent of a workflow, from the agent's compiled output. */
export function handoffToolSchemaFromOutput(output: CompiledOutput): HandoffToolSchema {
  return {
    input: output.toolInput,
    accept: (submission, context) =>
      acceptAgentOutput(output, submission, createOutputAcceptContext(context.executionCwd, context.scratchDir, context.readCommandEvidence)),
  };
}
