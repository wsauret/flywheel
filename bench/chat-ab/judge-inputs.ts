// What a chat-ab judge reads about one run, shared by the absolute scorer
// (score.ts) and the pairwise comparison (compare.ts): the request, the diff,
// and the final handoff, each redacted so that the judge cannot tell which
// arm or which model made the change.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { detectModelFamily } from "../../src/infra/llm/model-family.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { codedRolePreference } from "../../src/orchestration/config/role-model-defaults.js";
import type { CampaignConfig, RunRecord } from "./store.js";

/** The one judge of every chat-ab score and comparison. The model is the
 *  benchmark judge pin, and the effort is pinned too, so that a change of the
 *  model's default effort cannot move the scores between campaigns. */
export const CHAT_AB_JUDGE = codedRolePreference("benchmark-judge", "openai");

/** Why `judge` cannot judge these campaigns, or undefined when it can. The
 *  judge must come from a known model family that no seat of any campaign
 *  uses, so that it never grades its own family's work. */
export function judgeFamilyProblem(judge: string, configs: readonly CampaignConfig[]): string | undefined {
  const family = detectModelFamily(judge);
  if (family === null) return `The judge ${judge} has no known model family`;
  const seats = configs.flatMap((config) => [config.chat, ...config.roles]).filter((seat) => detectModelFamily(seat.model) === family);
  return seats.length === 0 ? undefined : `The judge ${judge} is from the ${family} family, like the ${seats[0]!.role} seat ${seats[0]!.model}`;
}

/** The words of a model id that its names share: `claude-opus-5.5` is also
 *  spelled `Claude Opus 5.5` or `Opus 5.5`. The vendor word may be left out
 *  when the rest still holds a word, never when only a version remains. */
export function modelNamePattern(model: string): string {
  const [vendor, ...rest] = model.replace(/\[\w+\]$/, "").split(/[\s.-]+/).filter(Boolean).map((word) => RegExp.escape(word));
  const separator = "[\\s.-]+";
  const body = rest.join(separator);
  const named = rest.some((word) => /[A-Za-z]/.test(word)) ? `(?:${vendor}${separator})?${body}` : [vendor, ...rest].join(separator);
  // A model id is never part of a longer id: claude-opus-5 does not hide the 5 of claude-opus-5.5.
  return `(?<![A-Za-z0-9])${named}(?![A-Za-z0-9]|[.-][A-Za-z0-9])`;
}

/** What the judge must not read in a run's inputs: the models of the seats of
 *  the campaigns it judges, the arm markers (the Flywheel
 *  tool prefix, the Agent SDK CLI's identity lines, its `claude-cli` client
 *  name, and reminder blocks), and the run's own temporary directories. Only
 *  those exact texts are hidden, because a diff can change other model ids
 *  and paths, and the judge must read them as code. */
export interface Redaction {
  /** Changes when the hidden texts change, so a score never mixes two redactions. */
  readonly identity: string;
  redact(text: string, directories?: RunRecord["cellDirectories"]): string;
}

export function campaignRedaction(configs: readonly CampaignConfig[]): Redaction {
  const models = [...new Set(configs.flatMap((config) => [config.chat, ...config.roles].map((seat) => seat.model)))].sort();
  const patterns: readonly (readonly [RegExp, string])[] = [
    // Campaigns recorded before the prefix rename name the server "flywheel".
    [/mcp__(?:flywheel|runtime)__/g, ""],
    [/You are (?:Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?|a Claude agent, built on Anthropic's Claude Agent SDK)\./g, ""],
    [/\bclaude-cli\b/gi, "<client>"],
    [/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""],
    ...models.map((model) => [new RegExp(modelNamePattern(model), "gi"), "<model>"] as const),
  ];
  return {
    identity: structuredIdentity({ directories: ["<repo>", "<home>"], patterns: patterns.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]) }),
    redact(text, directories) {
      // The longest spelling first, so that /private/var/x is not left as /private<repo>.
      const paths = [...(directories?.project ?? []).map((path) => [path, "<repo>"] as const), ...(directories?.home ?? []).map((path) => [path, "<home>"] as const)].sort(([left], [right]) => right.length - left.length);
      const withoutPaths = paths.reduce((current, [path, replacement]) => current.replaceAll(path, replacement), text);
      return patterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), withoutPaths);
    },
  };
}

const MAX_DIFF_CHARS = 120_000;

function clipDiff(diff: string): string {
  if (!diff.trim()) return "(empty diff: no change was made)";
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : diff;
}

const CellFinalHandoffSchema = Schema.Struct({
  finalHandoff: Schema.optional(Schema.NullOr(Schema.Struct({ content: Schema.Record(Schema.String, Schema.Unknown) }))),
});
// result.json holds the whole cell result; only the content of its final handoff is read here.
const decodeCellFinalHandoff = Schema.decodeUnknownSync(CellFinalHandoffSchema);

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "object" && item !== null && "command" in item && typeof item.command === "string") {
        const exit = "exitCode" in item && typeof item.exitCode === "number" ? ` (exit code ${item.exitCode})` : "";
        const observation = "observation" in item && typeof item.observation === "string" ? `: ${item.observation}` : "";
        return `- \`${item.command}\`${exit}${observation}`;
      }
      return `- ${typeof item === "string" ? item : JSON.stringify(item)}`;
    }).join("\n");
  }
  return JSON.stringify(value);
}

/** The final handoff of a workflow cell as the judge reads it: one section per
 *  field, with each cited command and its exit code. */
function renderFinalHandoff(resultText: string | undefined): string {
  const { finalHandoff } = decodeCellFinalHandoff(resultText === undefined ? {} : JSON.parse(resultText));
  if (finalHandoff === undefined) return "The handoff of this run was not captured.";
  if (finalHandoff === null) return "The workflow wrote no final handoff.";
  return Object.entries(finalHandoff.content).map(([key, value]) => `### ${key}\n${renderValue(value)}`).join("\n\n");
}

/** What a judge reads about one run, redacted. `handoff` is absent for a chat
 *  cell, which writes no handoff. */
export interface RunInputs {
  readonly request: string;
  readonly diff: string;
  readonly handoff?: string;
}

export async function runInputs(tasksDir: string, campaignDir: string, run: Pick<RunRecord, "task" | "artifactDir" | "workflow" | "cellDirectories">, redaction: Redaction): Promise<RunInputs> {
  const redact = (text: string) => redaction.redact(text, run.cellDirectories);
  const artifact = join(campaignDir, run.artifactDir);
  const diff = redact(clipDiff(await readFile(join(artifact, "diff.patch"), "utf8")));
  const request = redact((await readFile(join(tasksDir, run.task, "message.md"), "utf8")).trim());
  if (!run.workflow) return { request, diff };
  return { request, diff, handoff: redact(renderFinalHandoff(await readFile(join(artifact, "result.json"), "utf8").catch(() => undefined))) };
}
