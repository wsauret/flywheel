/** The six built-in workflow files as the last build before the phase
 *  grammar shipped them (commit 301e51b8b), byte for byte. A paused run of a
 *  built-in recorded the identity of this text, and the built-in no longer
 *  states it, so the identity proofs of that run rebuild the step-grammar
 *  record from here (refer to `retired-step-identity.ts`). A copy that differs
 *  from the base bytes fails the identity fixture of its workflow. Remove
 *  after 2027-04-30. */
import { Schema } from "effect";
import { parseWorkflowYaml } from "../../infra/workflow-yaml.js";
import { StepGrammarWorkflowSchema, type StepGrammarWorkflow } from "../retired-step-grammar/schema.js";

const RETIRED_BUILT_IN_TEXTS: ReadonlyMap<string, string> = new Map([
  ["debug", "id: debug\nname: Debug\ndescription: Investigate, fix, and verify a small reported issue.\nuse_when: >\n  Use for a small investigation and fix when the user reports a specific bug\n  and the root cause is not known. The workflow separates root-cause analysis,\n  the fix, and verification. Keep obvious fixes and clear local changes\n  in-process.\nconfirmation_template: debug\nsteps:\n  investigate:\n    file: steps/debug.investigate.md\n    writes:\n      - id: debug-investigation\n        lifetime: durable\n        supersedes: []\n  fix:\n    file: steps/debug.fix.md\n    writes:\n      - id: debug-fix\n        lifetime: durable\n        supersedes: []\n  verify:\n    file: steps/debug.verify.md\n    writes:\n      - id: debug-verification\n        lifetime: durable\n        supersedes: []\nflow:\n  - step: investigate\n    then:\n      step: fix\n      when: hypothesis\n  - while: verify.defects\n    maxIterations: 3\n    do: verify\n    then: fix\n"],
  ["implement", "id: implement\nname: Implement\ndescription: Turn a settled design into a reviewed implementation spec, then implement it.\nuse_when: >\n  Use when the design is already settled in chat and the work is substantial:\n  multiple dependent phases or architectural decisions whose mistakes would\n  invalidate later phases. Launch only when no user choice or technical\n  uncertainty remains and no phase needs discovery, experiments, or\n  proof-of-concept work; the workflow inspects the repository only to ground\n  the settled design in exact files, callers, and tests. Do not use it to\n  start designing, for a bounded change, for routine ticket-sized work, or for\n  bulk homogeneous work such as mass lint fixes, codemods, or renames. When\n  you can launch a workflow file, run bulk work as one that fans out over the\n  sites and verifies each one; otherwise drive it from chat as waves of\n  implementer subagents with per-batch verification.\n  Once the workflow is running, newly exposed implementation uncertainty belongs\n  to the active step: troubleshoot it, run a focused experiment or proof of concept,\n  and continue. The fact that work remains is not a blocker.\nconfirmation_template: spec-and-implement\nsteps:\n  spec-create:\n    file: steps/fly.spec-create.md\n    writes:\n      - id: plan\n        lifetime: durable\n        supersedes: []\n  spec-review:\n    file: steps/fly.spec-review.md\n    writes:\n      - id: reviewed-plan\n        lifetime: durable\n        supersedes:\n          - plan\n  implement:\n    file: steps/fly.implement.md\n    writes:\n      - id: implementation\n        lifetime: durable\n        supersedes: []\nflow:\n  - step: spec-create\n  - step: spec-review\n  - step: implement\n"],
  ["qa", "id: qa\nname: QA\ndescription: Inventory the user-visible surface, exercise every entry from scratch in each verification pass, fix reproducible issues, and record blocking findings.\nuse_when: >\n  The user wants an exhaustive QA pass on the current project: \"QA the app\",\n  \"do a full quality pass\", \"test every surface\". Every follow-up pass also\n  exercises the complete surface from scratch. Produces a timestamped run\n  directory under docs/qa/runs/ with a changelog and unclear-findings\n  document, and applies fixes in the same pass.\nconfirmation_template: qa\nrequires_description: false\nsteps:\n  surface-map:\n    file: steps/qa.surface-map.md\n    writes:\n      - id: surface-map\n        lifetime: durable\n        supersedes: []\n  test-fix-surface:\n    file: steps/qa.test-fix-surface.md\n    writes:\n      - qa-findings\n  review-fixes:\n    file: steps/qa.review-fixes.md\n    writes:\n      - qa-contest\nflow:\n  - step: surface-map\n  - step: test-fix-surface\n  - while: review-fixes.findings\n    do: review-fixes\n    then: test-fix-surface\n    maxIterations: 5\n    detectStuck: true"],
  ["bench-implement", "id: bench-implement\nname: Implement Step Benchmark\ndescription: Run the bundled implement step against a recorded plan fixture.\nuser-invocable: false\ndisable-model-invocation: true\nsteps:\n  implement:\n    file: bundled:steps/fly.implement.md\n    writes:\n      - id: implementation\n        lifetime: durable\n        supersedes: []\nflow:\n  - step: implement\n"],
  ["bench-plan", "id: bench-plan\nname: Plan Model Benchmark\ndescription: Run the spec-create step for model benchmarking.\nuser-invocable: false\ndisable-model-invocation: true\nsteps:\n  spec-create:\n    file: bundled:steps/fly.spec-create.md\n    writes:\n      - id: plan\n        lifetime: durable\n        supersedes: []\nflow:\n  - step: spec-create\n"],
  // Retired with its audit tooling. This list keeps every retired built-in id that durable history can still name.
  ["raindrop-audit", "id: raindrop-audit\nname: Raindrop Audit\ndescription: Audit one Raindrop bookmark against Flywheel and propose only the improvements the source justifies.\nuse_when: >\n  The user wants to process the Raindrop inspiration queue: \"audit my\n  bookmarks\", \"run a raindrop audit\", \"process the inspiration queue\", or\n  names one bookmark to audit. Follows the inspiration-audit playbook, writes\n  the research artifact and any warranted plan, and emits batched memory and\n  definition proposals a deterministic consumer records; a no-op audit is a\n  valid outcome.\ndisable-model-invocation: true\nrequires_description: false\nsteps:\n  raindrop-audit:\n    file: steps/fly.raindrop-audit.md\n    writes:\n      - inspiration-audit\nflow:\n  - step: raindrop-audit\n"],
]);

const decoded = new Map<string, StepGrammarWorkflow>();

/** The step-grammar record of the built-in workflow `workflowId` at the
 *  base, or undefined for any other id. */
export function retiredBuiltInDefinition(workflowId: string): StepGrammarWorkflow | undefined {
  const known = decoded.get(workflowId);
  if (known !== undefined) return known;
  const text = RETIRED_BUILT_IN_TEXTS.get(workflowId);
  if (text === undefined) return undefined;
  const workflow = Schema.decodeUnknownSync(StepGrammarWorkflowSchema, { onExcessProperty: "error" })(parseWorkflowYaml(text));
  decoded.set(workflowId, workflow);
  return workflow;
}

/** The base text of one built-in workflow, for the fixture that pins each
 *  copy to the base bytes. */
export function retiredBuiltInText(workflowId: string): string | undefined {
  return RETIRED_BUILT_IN_TEXTS.get(workflowId);
}
