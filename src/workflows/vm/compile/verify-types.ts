import { Schema } from "effect";

const NonEmptyStringSchema = Schema.NonEmptyString;

const WorkflowVerificationFindingSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  target: Schema.NullOr(NonEmptyStringSchema),
  message: NonEmptyStringSchema,
  witness: Schema.NullOr(Schema.Array(NonEmptyStringSchema)),
  noPathReason: Schema.NullOr(NonEmptyStringSchema),
}).check(Schema.makeFilter((finding) =>
  (finding.witness === null) !== (finding.noPathReason === null)
  || "A finding must have either a witness or a reason that no path is possible",
));

/** Every kind of uncertainty that the verifier can report. A kind is
 *  runtime data when only the values of a run decide it: the verifier proved
 *  every authored path, and what remains open is data that no definition can
 *  fix before launch. Any other kind means that the verifier stopped before it
 *  proved the authored graph, and a path launch warns about it. A new kind
 *  adds one row here. */
const VERIFICATION_UNCERTAINTY_KINDS = [
  { name: "runtime_handoff_values", runtimeData: true },
  { name: "model_reassessment_content", runtimeData: true },
  { name: "runtime_for_array_size", runtimeData: true },
  { name: "runtime_map_width", runtimeData: true },
  { name: "sampled_branch_outcomes", runtimeData: true },
  { name: "runtime_round_count", runtimeData: true },
  { name: "bounded_graph_exploration", runtimeData: false },
] as const;

export type VerificationUncertaintyKind = (typeof VERIFICATION_UNCERTAINTY_KINDS)[number]["name"];

const RUNTIME_DATA_UNCERTAINTIES: ReadonlySet<VerificationUncertaintyKind> = new Set(
  VERIFICATION_UNCERTAINTY_KINDS.filter(({ runtimeData }) => runtimeData).map(({ name }) => name),
);

const WorkflowVerificationUncertaintySchema = Schema.Struct({
  name: Schema.Literals(VERIFICATION_UNCERTAINTY_KINDS.map(({ name }) => name)),
  target: Schema.NullOr(NonEmptyStringSchema),
  detail: NonEmptyStringSchema,
});

const WorkflowVerificationReportSchema = Schema.Struct({
  result: Schema.Union([
    Schema.Literal("proved"),
    Schema.Literal("partially_proved"),
    Schema.Literal("invalid"),
  ]),
  findings: Schema.Array(WorkflowVerificationFindingSchema),
  uncertainties: Schema.Array(WorkflowVerificationUncertaintySchema),
}).check(Schema.makeFilter((report) => {
  if (report.result === "partially_proved" && report.uncertainties.length === 0) {
    return "A partially proved report must name at least one uncertainty";
  }
  if (report.result === "proved" && report.uncertainties.length > 0) {
    return "A proved report cannot contain uncertainty";
  }
  return true;
}));

export type WorkflowVerificationFinding = typeof WorkflowVerificationFindingSchema.Type;
export type WorkflowVerificationUncertainty = typeof WorkflowVerificationUncertaintySchema.Type;
export type WorkflowVerificationReport = typeof WorkflowVerificationReportSchema.Type;
export type WorkflowVerificationResult = WorkflowVerificationReport["result"];

export function parseWorkflowVerificationReport(value: unknown): WorkflowVerificationReport {
  return Schema.decodeUnknownSync(WorkflowVerificationReportSchema, { onExcessProperty: "error" })(value);
}

/** The findings that state what the verifier proved or how far it looked,
 *  not a defect: a report of any result can hold them. The verifier builds
 *  each one as a {@link ProofFinding}, so a new kind of proof is a row here
 *  or a type error. Every other finding of an `invalid` report is a defect. */
const PROOF_FINDING_KINDS = ["terminal_reachable", "retry_reachable", "while_bound", "array_bounded_for", "exploration_limit"] as const;

/** A finding that states what the verifier proved or how far it looked. */
export type ProofFinding = WorkflowVerificationFinding & { readonly name: (typeof PROOF_FINDING_KINDS)[number] };

const PROOF_FINDINGS: ReadonlySet<string> = new Set(PROOF_FINDING_KINDS);

/** What a launch of an agent-authored workflow file warns about in its
 *  verifier report: each defect of an `invalid` report, and each uncertainty
 *  that the values of a run do not decide, such as a bounded exploration. A
 *  launch never refuses a file for its report once the file parses: a file that the verifier did not prove can still run, and
 *  what goes wrong shows while it runs. */
interface LaunchVerificationWarnings {
  readonly findings: readonly WorkflowVerificationFinding[];
  readonly uncertainties: readonly WorkflowVerificationUncertainty[];
}

export function launchVerificationWarnings(report: WorkflowVerificationReport): LaunchVerificationWarnings {
  return {
    findings: report.result === "invalid" ? report.findings.filter(({ name }) => !PROOF_FINDINGS.has(name)) : [],
    uncertainties: report.uncertainties.filter(({ name }) => !RUNTIME_DATA_UNCERTAINTIES.has(name)),
  };
}
