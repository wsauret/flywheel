import { Schema } from "effect";
import { join } from "node:path";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { BenchmarkAccountingSchema } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import { openCampaignLedger } from "../../src/orchestration/modules/development/benchmark/campaign-ledger.js";
import { EffortSchema } from "../../src/infra/workflow-types.js";
import { canonicalModelId } from "../../src/infra/llm/model-id.js";
import { SourcePatchSchema } from "./source-treatment.js";

export const CampaignId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
export const CampaignHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const CampaignCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const CampaignText = Schema.NonEmptyString;
export const CampaignMessageSchema = Schema.Literal("design");
export const CampaignCellSchema = Schema.Struct({ treatment: CampaignId, task: CampaignId, repeat: CampaignCount });
export const CampaignArtifactSchema = Schema.Struct({ path: CampaignText, sha256: CampaignHash });
export const CampaignAttemptSchema = Schema.Struct({
  kind: Schema.Literal("attempt"), attemptId: CampaignText, cell: CampaignCellSchema, at: CampaignText, directory: CampaignText,
});
export type CampaignCell = typeof CampaignCellSchema.Type;
export type CampaignAttempt = typeof CampaignAttemptSchema.Type;

/** Each non-Chat role's resolved model and effort, as the subject's public roleSnapshot query reports it. */
export const ResolvedRolesSchema = Schema.Record(CampaignText, Schema.Struct({ model: CampaignText, effort: CampaignText }));
/** The complete role table a Flywheel treatment runs on, passed to the subject as `FLYWHEEL_ROLES`. A role it does not
 *  name takes the treatment source's shipped default; the operator's role settings never reach the cell. */
export const CampaignRolesSchema = Schema.Record(CampaignText, Schema.Struct({ model: Schema.optionalKey(CampaignText), effort: Schema.optionalKey(EffortSchema) }));
export type CampaignRoles = typeof CampaignRolesSchema.Type;
export const CampaignDisabledToolsSchema = Schema.Array(CampaignText).check(Schema.isUnique());
export const CampaignTreatmentFields = {
  id: CampaignId, revision: CampaignText, sourceIdentity: CampaignHash, dependencyIdentity: CampaignHash,
  harnessIdentity: CampaignHash, settingsIdentity: CampaignHash,
  subject: Schema.optionalKey(Schema.Literal("flywheel")),
  // Read preflight snapshots from existing manifests until after 2027-10-14. New campaigns retain roles only in cell artifacts.
  resolvedRoles: Schema.optionalKey(ResolvedRolesSchema),
  roles: Schema.optionalKey(CampaignRolesSchema),
  disabledTools: Schema.optionalKey(CampaignDisabledToolsSchema),
  patches: Schema.optionalKey(Schema.Array(SourcePatchSchema)),
  workflowsMode: Schema.optionalKey(Schema.Literal("on")),
};
export const ClaudeCodeTreatmentFields = {
  id: CampaignId, subject: Schema.Literal("claude-code"), binaryPath: CampaignText, binarySha256: CampaignHash,
  binaryVersion: CampaignText, model: CampaignText, effort: CampaignText, settingsIdentity: CampaignHash,
  ultracode: Schema.optionalKey(Schema.Literal(true)),
};
const CampaignTreatmentSchema = Schema.Union([
  Schema.Struct(CampaignTreatmentFields), Schema.Struct(ClaudeCodeTreatmentFields),
]);
export type CampaignTreatmentRecord = typeof CampaignTreatmentSchema.Type;
export const CampaignManifestV2Fields = {
  version: Schema.Literal(2), name: CampaignId,
  model: CampaignText, effort: CampaignText, authProfile: CampaignText,
  answers: Schema.Literal("approve-root-workflow-launch"), infrastructureIdentity: CampaignHash,
  environmentIdentity: Schema.optionalKey(CampaignHash),
  message: Schema.optionalKey(CampaignMessageSchema),
  challenge: Schema.optionalKey(Schema.Literal(true)),
  treatments: Schema.Array(CampaignTreatmentSchema),
  repeats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), createdAt: CampaignText,
};
export type CampaignManifestFields = Schema.Struct<typeof CampaignManifestV2Fields>["Type"];

export const CampaignOutcomeV2Fields = {
  kind: Schema.Literal("outcome"), version: Schema.Literal(2), attemptId: CampaignText, cell: CampaignCellSchema, at: CampaignText,
  status: Schema.Literals(["completed", "failed"]), reason: Schema.NullOr(CampaignText),
  runs: Schema.Array(Schema.Struct({
    outcome: Schema.Literals(["complete", "input_required", "incomplete", "failed"]),
    exitCode: Schema.NullOr(Schema.Int), wallMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    sessionId: Schema.NullOr(CampaignText), reason: Schema.NullOr(CampaignText),
    models: Schema.optionalKey(Schema.Array(CampaignText)),
    workflowsMode: Schema.optionalKey(Schema.Literals(["on", "ask", "off"])),
    evidence: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("observed"), requestCount: CampaignCount, parentRequestCount: CampaignCount, childSessionCount: CampaignCount }),
      Schema.Struct({ kind: Schema.Literal("unavailable"), reason: CampaignText }),
    ]),
    artifacts: Schema.Array(CampaignArtifactSchema),
  })),
  accounting: BenchmarkAccountingSchema, parentAccounting: BenchmarkAccountingSchema, approvals: CampaignCount,
  report: Schema.NullOr(CampaignArtifactSchema), diff: Schema.NullOr(CampaignArtifactSchema),
  challenge: Schema.optionalKey(Schema.Union([
    Schema.Struct({ delivered: Schema.Literals(["revise-design", "message"]) }),
    Schema.Struct({ delivered: Schema.Literal("none"), reason: CampaignText }),
  ])),
  challengeReply: Schema.optionalKey(CampaignArtifactSchema),
};
const ExecutionSchema = Schema.Struct(CampaignOutcomeV2Fields);
export type CampaignExecutionOutcome = typeof ExecutionSchema.Type;

export interface CampaignManifest {
  readonly kind: string;
  readonly version: number;
  readonly createdAt: string;
  readonly repeats: number;
  readonly model?: string;
  readonly effort?: string;
  readonly authProfile?: string;
  readonly treatments: readonly {
    readonly id: string;
    readonly subject?: string;
    readonly resolvedRoles?: typeof ResolvedRolesSchema.Type;
    readonly settingsIdentity?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly authProfile?: string;
    readonly roles?: CampaignRoles;
    readonly disabledTools?: readonly string[];
    readonly arm?: { readonly id: string; readonly identity: string | null; readonly invokeSkill: string | null };
  }[];
  readonly tasks: readonly { readonly id: string }[];
}
export interface CampaignOutcome {
  readonly kind: "outcome";
  readonly attemptId: string;
  readonly cell: CampaignCell;
  readonly status: "completed" | "failed";
}

/** Family schemas own task identities and grade fields. The ledger never converts retained bytes. */
export function createCampaignLedger<M extends CampaignManifest, O extends CampaignOutcome>(schemas: {
  readonly manifest: Schema.Decoder<M>;
  readonly outcome: (manifest: M) => Schema.Decoder<O>;
  readonly events: Schema.Decoder<CampaignAttempt | O>;
  readonly requireWritable: (manifest: M) => void;
}) {
  function validate(manifest: M, events: readonly (CampaignAttempt | O)[]) {
    if (manifest.treatments.length === 0 || manifest.tasks.length === 0) throw new Error("A campaign needs at least one treatment and one task");
    for (const entries of [manifest.treatments, manifest.tasks]) {
      if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new Error("Campaign IDs must be unique");
    }
    const scheduled = new Set(campaignSchedule(manifest).map(campaignCellKey));
    const attempts = new Map<string, CampaignAttempt>();
    const settled = new Map<string, O>();
    const completed = new Map<string, O>();
    for (const event of events) {
      if (event.kind === "attempt") Schema.decodeUnknownSync(CampaignAttemptSchema, { onExcessProperty: "error" })(event);
      else Schema.decodeUnknownSync(schemas.outcome(manifest), { onExcessProperty: "error" })(event);
      const key = campaignCellKey(event.cell);
      if (!scheduled.has(key)) throw new Error(`Evidence names an unscheduled cell: ${key}`);
      if (event.kind === "attempt") {
        if (attempts.has(event.attemptId)) throw new Error(`Duplicate attempt: ${event.attemptId}`);
        if (completed.has(key)) throw new Error(`Attempt follows completed cell: ${key}`);
        attempts.set(event.attemptId, event);
      } else {
        const attempt = attempts.get(event.attemptId);
        if (!attempt || campaignCellKey(attempt.cell) !== key) throw new Error(`Outcome has no matching earlier attempt: ${event.attemptId}`);
        if (settled.has(event.attemptId)) throw new Error(`Duplicate outcome: ${event.attemptId}`);
        if (completed.has(key)) throw new Error(`Duplicate completion: ${key}`);
        settled.set(event.attemptId, event);
        if (event.status === "completed") completed.set(key, event);
      }
    }
    return { attempts, settled, completed };
  }
  return {
    validate,
    decodeOutcome(manifest: M, value: unknown): O {
      return Schema.decodeUnknownSync(schemas.outcome(manifest), { onExcessProperty: "error" })(value);
    },
    pending(manifest: M, events: readonly (CampaignAttempt | O)[]): CampaignCell[] {
      const { completed } = validate(manifest, events);
      return campaignSchedule(manifest).filter((cell) => !completed.has(campaignCellKey(cell)));
    },
    async open(directory: string, expected?: M) {
      return await openCampaignLedger(directory, {
        ...schemas, identity: campaignIdentity, validate,
        resolvePath: async name => join(directory, name),
      }, expected);
    },
  };
}

/** Preserve the recorded identity for verified pre-conversion judge configurations. */
export function recordedCampaignIdentity(manifest: CampaignManifest): string {
  const { createdAt: _, ...identity } = manifest;
  return structuredIdentity(identity);
}

/** Convert the known role-aware v2 digest in memory. Retained manifests and receipts remain immutable.
 * Remove this conversion after 2027-10-14. Only an exact reconstruction permits removal of inherited roles. */
export function campaignIdentity(manifest: CampaignManifest): string {
  if (manifest.version !== 2) return recordedCampaignIdentity(manifest);
  const treatments = manifest.treatments.map((treatment) => {
    if (!treatment.resolvedRoles || treatment.subject === "claude-code") return treatment;
    const family = manifest.kind === "chat-ab" ? structuredIdentity(treatment.arm) : undefined;
    const model = treatment.model ?? manifest.model;
    if (!model) throw new Error("Cannot convert role-aware campaign: missing Chat model");
    const inputs = { profileId: treatment.authProfile ?? manifest.authProfile, model: canonicalModelId(model), effort: treatment.effort ?? manifest.effort,
      ...(treatment.roles ? { roles: treatment.roles } : {}), ...(family ? { family } : {}) };
    if (structuredIdentity({ ...inputs, rolesIdentity: structuredIdentity(treatment.resolvedRoles) }) !== treatment.settingsIdentity) {
      throw new Error(`Cannot convert role-aware campaign: settings identity does not match recorded inputs (${treatment.id})`);
    }
    const { resolvedRoles: _, ...converted } = treatment;
    return { ...converted, settingsIdentity: structuredIdentity(inputs) };
  });
  return recordedCampaignIdentity({ ...manifest, treatments });
}

export function campaignCellKey(cell: CampaignCell): string {
  return `${cell.treatment}/${cell.task}/${cell.repeat}`;
}

/** Rotate the first treatment within each task and repeat; execute one cell at a time. */
export function campaignSchedule(manifest: CampaignManifest): CampaignCell[] {
  const cells: CampaignCell[] = [];
  for (let repeat = 0; repeat < manifest.repeats; repeat++) {
    for (const [taskIndex, task] of manifest.tasks.entries()) {
      for (let index = 0; index < manifest.treatments.length; index++) {
        const treatment = manifest.treatments[(index + repeat + taskIndex) % manifest.treatments.length]!;
        cells.push({ treatment: treatment.id, task: task.id, repeat });
      }
    }
  }
  return cells;
}
