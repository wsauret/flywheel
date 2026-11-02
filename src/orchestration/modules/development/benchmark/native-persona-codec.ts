import { Schema } from "effect";
import { EffortSchema } from "../../../../infra/workflow-types.js";
import { rename } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { BenchmarkAccountingSchema, unavailableBenchmarkAccounting } from "./evidence.js";

export const NATIVE_STARTUP_TIMEOUT_MS = 180_000;
export const NATIVE_SETTLEMENT_GRACE_MS = 180_000;
export const NATIVE_CANDIDATE_TIMEOUT_MS = 25 * 60_000;
const PositiveMilliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const StartupPhase = Schema.Literals(["request", "launcher", "isolation", "account", "imports", "runtime", "identity", "admission"]);
const StartupCause = Schema.Literals(["operation-failed", "account-home-changed", "account-identity-changed", "module-selection-changed", "guidance-changed", "admission-changed"]);

const agentFields = {
  name: Schema.NonEmptyString,
  description: Schema.String,
  maxTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  subagentRoles: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
};
const PersonaSchema = Schema.Struct({
  ...agentFields,
  kind: Schema.Literal("persona"),
  systemPrompt: Schema.String,
  tools: Schema.Array(Schema.NonEmptyString),
  requiredSkills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  role: Schema.NonEmptyString,
  allowFork: Schema.optionalKey(Schema.Boolean),
});
const AgentSchema = Schema.Union([PersonaSchema, Schema.Struct({ ...agentFields, kind: Schema.Literal("general") })]);

const RequestSchema = Schema.Struct({
  sourceRoot: Schema.NonEmptyString,
  accountHome: Schema.NonEmptyString,
  usageAuthority: Schema.Struct({ profileId: Schema.NonEmptyString, authorityIncarnation: Schema.NonEmptyString }),
  guidanceIdentity: Schema.NonEmptyString,
  moduleIds: Schema.Array(Schema.NonEmptyString),
  admissionIdentity: Schema.Struct({ runtimeConfig: Schema.NonEmptyString }),
  persona: PersonaSchema,
  registry: Schema.Array(Schema.Tuple([Schema.String, AgentSchema])),
  seat: Schema.Struct({ model: Schema.optionalKey(Schema.NonEmptyString), effort: Schema.optionalKey(EffortSchema) }),
  prompt: Schema.String,
  label: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  path: Schema.Array(Schema.NonEmptyString),
  timeoutMs: Schema.optionalKey(PositiveMilliseconds),
  transcriptPath: Schema.optionalKey(Schema.NonEmptyString),
});
const accountingFields = {
  accounting: BenchmarkAccountingSchema,
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};
const ResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("completed"),
    ...accountingFields,
    handoff: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    summary: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsuccessful"),
    ...accountingFields,
    terminal: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("timed-out"), timeoutMs: PositiveMilliseconds }),
      Schema.Struct({ kind: Schema.Literal("cancelled") }),
    ]),
    message: Schema.String,
    startup: Schema.optionalKey(Schema.Struct({ phase: StartupPhase, cause: StartupCause })),
  }),
]);

export type NativePersonaResult = typeof ResultSchema.Type;

/** Current worker IPC rejects missing, invalid, and excess fields on both sides of the process boundary. */
export const decodeNativePersonaRequest = Schema.decodeUnknownSync(RequestSchema, { onExcessProperty: "error" });
export const decodeNativePersonaResult = Schema.decodeUnknownSync(ResultSchema, { onExcessProperty: "error" });

/** Resolves validated task toolchains in declared order, ahead of the inherited candidate PATH. */
export function nativePersonaPath(request: { workspace: string; path: readonly string[] }, inheritedPath: string | undefined): string {
  return [...request.path.map(path => resolve(request.workspace, path)), ...(inheritedPath ? [inheritedPath] : [])].join(delimiter);
}

/** Publishes a complete strict IPC result atomically, so settlement never observes partial JSON. */
export async function writeNativePersonaResult(path: string, result: NativePersonaResult): Promise<void> {
  await Bun.write(`${path}.pending`, JSON.stringify(decodeNativePersonaResult(result)));
  await rename(`${path}.pending`, path);
}

/** Startup diagnostics use closed phase and cause identifiers, never arbitrary exception or subprocess content. */
export function nativePersonaStartupFailure(
  phase: typeof StartupPhase.Type,
  cause: typeof StartupCause.Type,
  durationMs: number,
): NativePersonaResult {
  const message = `Native startup failed: ${phase}/${cause}`;
  return {
    kind: "unsuccessful", terminal: { kind: "failed", message }, message,
    startup: { phase, cause }, durationMs,
    accounting: unavailableBenchmarkAccounting("native startup failed before observable candidate accounting"),
  };
}
