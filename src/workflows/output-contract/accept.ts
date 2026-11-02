import { realpath } from "node:fs/promises";
import path from "node:path";
import { Result, Schema, SchemaIssue } from "effect";
import { errorMessage } from "../../infra/error-message.js";
import { JsonSyntaxError, parseJsonSource, type JsonSource } from "../../infra/json-source.js";
import { isRecord, type UnknownRecord } from "../../infra/record.js";
import type { CompiledOutput, OutputCheckContext } from "./compile.js";
import { canonicalizeCommandRuns, isRecordedCommandRunPath, resolveCommandRuns, type CommandRunRepair } from "./evidence.js";
import type { OutputIssue } from "./paths.js";

/** The boundary every agent output crosses before it becomes a fact (plan
 *  section 4.1). The handoff tool runs it on each submission, so a worker
 *  gets every problem of its submission in one report and can repair them in
 *  one turn. Nothing here depends on which agent submits. */

/** The largest output file the host reads in `submit: file` mode. */
const MAX_OUTPUT_FILE_BYTES = 1_000_000;

export interface OutputAcceptContext extends OutputCheckContext {
  /** The submitting agent's own scratchpad directory, which its system prompt
   *  names. A `submit: file` output must be a file inside it. */
  readonly scratchDir?: string;
  /** Whether a regular file exists at the path, through symlinks. */
  readonly fileExists: (absolutePath: string) => Promise<boolean>;
  /** Read a regular file as text. Rejects a file larger than `maxBytes` when
   *  the caller gives a bound. */
  readonly readText: (absolutePath: string, maxBytes?: number) => Promise<string>;
}

/** `repairs` are the changes that citation resolution made to the
 *  submission, which the worker learns of whether or not it was accepted. */
export type OutputAcceptance =
  | { readonly ok: true; readonly payload: UnknownRecord; readonly repairs: readonly CommandRunRepair[] }
  /** `recovery` tells the worker how to submit again. */
  | { readonly ok: false; readonly issues: readonly string[]; readonly recovery: string; readonly repairs: readonly CommandRunRepair[] };

const inlineRecovery = "Call handoff again with one JSON object that matches the field reference in your instructions.";

function fileRecovery(output: CompiledOutput): string {
  return `Fix \`path\` if it names the wrong file. Otherwise edit that JSON file so that it holds exactly the keys of the output contract (${["summary", ...output.fields.map(({ key }) => key)].map((key) => `\`${key}\``).join(", ")}), then call \`handoff\` again with only \`path\`. Do not put the output in the \`handoff\` call itself.`;
}

const formatStandardSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type StandardSchemaPathSegment = PropertyKey | { readonly key: PropertyKey };

function schemaPathSegments(segments: readonly StandardSchemaPathSegment[] | undefined): (string | number)[] {
  return (segments ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });
}

function lineSuffix(source: JsonSource | undefined, segments: readonly (string | number)[]): string {
  const line = source?.lineOf(segments);
  return line === undefined ? "" : ` (line ${line})`;
}

interface LocatedIssue {
  readonly segments: readonly (string | number)[];
  readonly message: string;
}

function locatedIssues(issue: SchemaIssue.Issue, at: readonly string[]): LocatedIssue[] {
  return formatStandardSchemaIssues(issue).issues.map((entry) => ({ segments: [...at, ...schemaPathSegments(entry.path)], message: entry.message }));
}

function outputIssue({ segments, message }: LocatedIssue): OutputIssue {
  return { path: segments.length === 0 ? "(root)" : segments.join("."), message };
}

/** Every issue of one failed decode at its dotted JSON path, the form every
 *  check reports. `at` names the payload key that the decoded value came
 *  from, for a check that decodes one value of the payload. */
export function schemaIssues(issue: SchemaIssue.Issue, at: readonly string[] = []): OutputIssue[] {
  return locatedIssues(issue, at).map(outputIssue);
}

/** Every strict-decode issue except those on the keys that citation
 *  resolution records, which the model never sends. */
function decodeIssues(issue: SchemaIssue.Issue): OutputIssue[] {
  return locatedIssues(issue, []).filter(({ segments }) => !isRecordedCommandRunPath(segments)).map(outputIssue);
}

/** One entry per issue as the worker reads it, with the file line when the
 *  payload came from a file. */
export function describeOutputIssues(issues: readonly OutputIssue[], source?: JsonSource): string[] {
  return issues.map((entry) => {
    const segments = entry.path === "(root)" ? [] : entry.path.split(".");
    return `${entry.path}${lineSuffix(source, segments)}: ${entry.message}${entry.hint ? ` (${entry.hint})` : ""}`;
  });
}

class SubmissionError extends Error {}

/** Resolve a `submit: file` submission to the payload its file holds. The
 *  path must resolve, through every symlink, to a regular file inside the
 *  agent's scratchpad directory. The stored output is the file's content, not
 *  its path. */
async function readOutputFile(submission: UnknownRecord, context: OutputAcceptContext): Promise<{ payload: UnknownRecord; source: JsonSource }> {
  const extra = Object.keys(submission).filter((key) => key !== "path");
  if (extra.length > 0) throw new SubmissionError(`unknown top-level fields: ${extra.join(", ")}. Put the output in the file and pass only path.`);
  const candidate = submission.path;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new SubmissionError("path: expected the absolute path of the output file");
  if (!context.scratchDir) throw new SubmissionError("path: this agent has no scratchpad directory, so it cannot submit an output file");
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new SubmissionError(`path: the output file cannot be resolved: ${errorMessage(error)}`);
  }
  // A file inside the scratchpad proves that the scratchpad exists, so a
  // scratchpad that does not resolve can only mean the file is outside it.
  const root = await realpath(context.scratchDir).catch(() => undefined);
  if (root === undefined || !canonical.startsWith(`${root}${path.sep}`)) throw new SubmissionError(`path: the output file must be inside your scratchpad directory ${context.scratchDir}`);
  if (!await context.fileExists(canonical)) throw new SubmissionError("path: the output file must be a regular file");
  let text: string;
  try {
    text = await context.readText(canonical, MAX_OUTPUT_FILE_BYTES);
  } catch (error) {
    throw new SubmissionError(`path: ${errorMessage(error)}`);
  }
  let source: JsonSource;
  try {
    source = parseJsonSource(text);
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    throw new SubmissionError(`path: the output file is not valid JSON at ${error.message}`);
  }
  if (!isRecord(source.value)) throw new SubmissionError("path: the output file must hold one JSON object at its top level");
  return { payload: source.value, source };
}

/** Decode and check one payload: command-run aliases become canonical keys,
 *  an inline output's citations resolve against the ledger, then the strict
 *  decode and the contract's own check both run. The check runs even when the
 *  decode fails, so one report names every issue. */
export async function validateAgentOutput(
  output: CompiledOutput,
  submitted: UnknownRecord,
  context: OutputCheckContext,
): Promise<{ readonly payload: UnknownRecord; readonly issues: readonly OutputIssue[]; readonly repairs: readonly CommandRunRepair[] }> {
  const canonical = canonicalizeCommandRuns(submitted);
  const { payload, repairs } = output.mode === "inline" && context.readCommandEvidence
    ? await resolveCommandRuns(canonical, context.readCommandEvidence)
    : { payload: canonical, repairs: [] };
  const decoded = Schema.decodeUnknownResult(output.schema, { errors: "all" })(payload);
  const issues = [
    ...(Result.isFailure(decoded) ? decodeIssues(decoded.failure.issue) : []),
    ...await output.check(payload, context),
  ];
  return { payload: Result.isSuccess(decoded) && isRecord(decoded.success) ? decoded.success : payload, issues, repairs };
}

/** Accept one handoff submission: in file mode, read the output file first;
 *  then validate the payload. */
export async function acceptAgentOutput(
  output: CompiledOutput,
  submission: UnknownRecord,
  context: OutputAcceptContext,
): Promise<OutputAcceptance> {
  const recovery = output.mode === "file" ? fileRecovery(output) : inlineRecovery;
  let submitted = submission;
  let source: JsonSource | undefined;
  if (output.mode === "file") {
    try {
      ({ payload: submitted, source } = await readOutputFile(submission, context));
    } catch (error) {
      if (!(error instanceof SubmissionError)) throw error;
      return { ok: false, issues: [error.message], recovery, repairs: [] };
    }
  }
  const { payload, issues, repairs } = await validateAgentOutput(output, submitted, context);
  return issues.length === 0 ? { ok: true, payload, repairs } : { ok: false, issues: describeOutputIssues(issues, source), recovery, repairs };
}
