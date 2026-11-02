import { isRecord, type UnknownRecord } from "../../infra/record.js";
import { recordedCommandRunKeys, type RecordedCommandRunKey } from "./envelope.js";
import type { OutputIssue } from "./paths.js";

/** The one citation path of an agent output.
 *
 *  `commands_run` exists only at the top level of the envelope, so every
 *  function here reads and writes that one key and takes no path parameter. */

/** One tool call of the worker conversation. `exitCode` is present only for a
 *  shell command call that completed in the foreground, which is the only
 *  kind of call an agent output can cite. `cwd` is the absolute directory
 *  that a shell call named. `changedAfter` names each file that changed in
 *  the agent's session after the call's result, in order; it is empty for a
 *  call with no exit code. */
export interface CommandEvidence {
  readonly toolUseId: string;
  readonly command: string | undefined;
  readonly cwd: string | undefined;
  readonly exitCode: number | undefined;
  readonly changedAfter: readonly string[];
  readonly executionMode: "foreground" | "background";
}

export type ReadCommandEvidence = () => Promise<readonly CommandEvidence[]>;

const commandRunAliases = [["tool_use_id", "toolUseId"], ["cmd", "command"], ["exit_code", "exitCode"], ["note", "observation"]] as const;

/** Canonicalize LLM alias keys on command-run records at the boundary, so
 *  resolution, the check, and every stored output speak one shape. The
 *  canonical key wins when both are present; other keys stay for the strict
 *  decode to reject. */
export function canonicalizeCommandRuns(payload: UnknownRecord): UnknownRecord {
  if (!Array.isArray(payload.commands_run)) return payload;
  const canonicalRecord = (record: UnknownRecord): UnknownRecord => {
    const canonical: UnknownRecord = {};
    for (const [key, item] of Object.entries(record)) {
      const alias = commandRunAliases.find(([from]) => from === key);
      if (!alias) canonical[key] = item;
      else if (record[alias[1]] === undefined) canonical[alias[1]] = item;
    }
    return canonical;
  };
  return { ...payload, commands_run: payload.commands_run.map((entry: unknown) => (isRecord(entry) ? canonicalRecord(entry) : entry)) };
}

/** One repair that resolution made to the cited runs. `index` is the
 *  record's position in the list that the model sent. */
export type CommandRunRepair =
  | { readonly kind: "ignored_field"; readonly index: number; readonly field: RecordedCommandRunKey }
  | { readonly kind: "repeated_citation"; readonly index: number; readonly toolUseId: string; readonly first: number }
  | { readonly kind: "dropped_citation"; readonly index: number; readonly toolUseId: string };

export interface ResolvedCommandRuns {
  readonly payload: UnknownRecord;
  readonly repairs: readonly CommandRunRepair[];
}

/** What the ledger records for one completed foreground shell call. */
interface RecordedRun {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly changedAfter: readonly string[];
}

function recordedRun(entry: CommandEvidence): readonly (readonly [string, RecordedRun])[] {
  const { toolUseId, command, cwd, exitCode, changedAfter, executionMode } = entry;
  return executionMode === "foreground" && command !== undefined && cwd !== undefined && exitCode !== undefined
    ? [[toolUseId, { command, cwd, exitCode, changedAfter }]]
    : [];
}

/** Resolve each cited record against the durable execution ledger, so the
 *  stored record states only what ran. The model cites a call by its
 *  `toolUseId`; the ledger supplies `command`, `cwd`, `exitCode`, and
 *  `changedAfter`, and a value the model sent for any of them is ignored. A citation that names no completed
 *  foreground shell call of this conversation is left out. A second citation
 *  of the same call is left out too, so the first record and its observation
 *  stand for the call. Each change is a repair that the handoff reports. A
 *  record that is not an object or has no string `toolUseId` stays for the
 *  strict decode to reject. The ledger is read only when some record cites a
 *  call. */
export async function resolveCommandRuns(payload: UnknownRecord, readCommandEvidence: ReadCommandEvidence): Promise<ResolvedCommandRuns> {
  const records: readonly unknown[] = Array.isArray(payload.commands_run) ? payload.commands_run : [];
  if (!records.some((entry) => isRecord(entry) && typeof entry.toolUseId === "string")) return { payload, repairs: [] };
  const recorded = new Map((await readCommandEvidence()).flatMap(recordedRun));
  const repairs: CommandRunRepair[] = [];
  const firstCitation = new Map<string, number>();
  const resolved = records.flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.toolUseId !== "string") return [entry];
    const toolUseId = entry.toolUseId;
    const run = recorded.get(toolUseId);
    const first = firstCitation.get(toolUseId);
    if (!run) {
      repairs.push({ kind: "dropped_citation", index, toolUseId });
      return [];
    }
    if (first !== undefined) {
      repairs.push({ kind: "repeated_citation", index, toolUseId, first });
      return [];
    }
    firstCitation.set(toolUseId, index);
    for (const field of recordedCommandRunKeys) {
      if (entry[field] !== undefined) repairs.push({ kind: "ignored_field", index, field });
    }
    return [{ ...entry, ...run }];
  });
  return { payload: { ...payload, commands_run: resolved }, repairs };
}

/** The one-line note that tells the model how the handoff read its citations. */
export function describeCommandRunRepair(repair: CommandRunRepair): string {
  switch (repair.kind) {
    case "ignored_field":
      return `Note: \`commands_run.${repair.index}.${repair.field}\` was ignored; the runtime records it from the cited call.`;
    case "repeated_citation":
      return `Note: \`commands_run.${repair.index}\` cited \`${repair.toolUseId}\` again, so it was left out; \`commands_run.${repair.first}\` keeps its observation.`;
    case "dropped_citation":
      return `Note: \`commands_run.${repair.index}\` cited \`${repair.toolUseId}\`, which is not a completed foreground shell command call of this attempt, so it was left out.`;
  }
}

/** True when `path` names a key of a command-run record that resolution
 *  records from the ledger. The model never sends these keys, so a decode
 *  issue there would tell it to type what the runtime records. A record that
 *  still lacks them has a citation problem, which its own issues report. */
export function isRecordedCommandRunPath(path: readonly (string | number)[]): boolean {
  const [list, index, field] = path;
  return path.length === 3 && list === "commands_run" && typeof index === "number" && recordedCommandRunKeys.some((key) => key === field);
}

function eligibleCallsHint(evidence: readonly CommandEvidence[]): string {
  const eligible = evidence
    .filter((entry) => entry.executionMode === "foreground" && entry.exitCode !== undefined)
    .map((entry) => `${entry.toolUseId} (${entry.command ?? "unknown command"})`)
    .join(", ");
  return eligible === ""
    ? "Run the command with the shell tool, then copy the id from the [toolUseId: ...] line that ends its result."
    : `Eligible shell command calls: ${eligible}`;
}

/** Hold the resolved citations to the contract's `commands.min` (0 when the
 *  contract declares none). Resolution already left out every citation that
 *  names no completed foreground shell call, so an attempt that cited too few
 *  real calls is refused here, and the report names the calls it can cite.
 *  Without a ledger no citation can be resolved, so any citation is refused. */
export async function checkCommandCitations(
  payload: UnknownRecord,
  min: number,
  readCommandEvidence: ReadCommandEvidence | undefined,
): Promise<readonly OutputIssue[]> {
  const commands = payload.commands_run;
  if (commands !== undefined && !Array.isArray(commands)) {
    return [{ path: "commands_run", message: "expected an array of command records" }];
  }
  const count = commands?.length ?? 0;
  if (count === 0 && min === 0) return [];
  if (!readCommandEvidence) {
    return [{ path: "commands_run", message: "command evidence is unavailable in this validation context" }];
  }
  if (count >= min) return [];
  return [{ path: "commands_run", message: `expected at least ${min} cited command run${min === 1 ? "" : "s"}`, hint: eligibleCallsHint(await readCommandEvidence()) }];
}
