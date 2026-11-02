#!/usr/bin/env bun
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Schema } from "effect";
import { decodeExecutionEvidence, type ExecutionEvidence } from "../../src/protocol/execution-evidence.js";
import { CampaignAttemptSchema } from "./campaign-store.js";

/** One span of a cell: chat, one workflow agent, one ordinary subagent, or background work. Times are milliseconds
 *  from the cell's first model request. Cost is unavailable when no usage priced it. */
export interface Phase {
  readonly label: string;
  readonly kind: RequestKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly requests: number;
  readonly outputTokens: number;
  /** The priced cost of the phase's requests; `unpriced` counts the requests no usage priced. */
  readonly usd: number;
  readonly unpriced: number;
  readonly models: readonly string[];
}

/** Agent kinds retain their session or transcript provenance; background requests have no conversation owner. */
type RequestKind = "chat" | "workflow-agent" | "subagent" | "background";

interface Request {
  readonly group: string;
  readonly label: string;
  readonly kind: RequestKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly outputTokens: number;
  readonly usd: number | null;
  readonly model: string;
}

const CHAT_BEFORE = "chat before launch";
const CHAT_DURING = "chat during workflow";
const CHAT_AFTER = "chat after completion";

/** Fold requests into phases. Chat requests split at the first and last workflow request; every other group retains
 *  its own phase, in the order it first sent a request. */
function phasesOf(requests: readonly Request[]): Phase[] {
  if (requests.length === 0) return [];
  const origin = Math.min(...requests.map((request) => request.startMs));
  const agents = requests.filter((request) => request.kind === "workflow-agent");
  const workflowStart = agents.length === 0 ? Infinity : Math.min(...agents.map((request) => request.startMs));
  const workflowEnd = agents.length === 0 ? Infinity : Math.max(...agents.map((request) => request.endMs));
  const groups = new Map<string, Request[]>();
  for (const request of [...requests].sort((left, right) => left.startMs - right.startMs)) {
    const label = request.kind !== "chat" ? request.group : request.startMs < workflowStart ? CHAT_BEFORE : request.startMs >= workflowEnd ? CHAT_AFTER : CHAT_DURING;
    groups.set(label, [...groups.get(label) ?? [], request]);
  }
  return [...groups].map(([label, members]) => ({
    label: members[0]!.kind === "chat" ? label : members[0]!.label,
    kind: members[0]!.kind,
    startMs: Math.min(...members.map((request) => request.startMs)) - origin,
    endMs: Math.max(...members.map((request) => request.endMs)) - origin,
    requests: members.length,
    outputTokens: members.reduce((total, request) => total + request.outputTokens, 0),
    usd: members.reduce((total, request) => total + (request.usd ?? 0), 0),
    unpriced: members.filter((request) => request.usd === null).length,
    models: [...new Set(members.map((request) => request.model))].sort(),
  })).sort((left, right) => left.startMs - right.startMs);
}

/** Flywheel phases from canonical execution evidence. A workflow agent is one conversation, named by the step id its
 *  usage records; a request with no conversation, such as a background review, is grouped by its model. */
export function flywheelPhases(evidence: ExecutionEvidence): Phase[] {
  const requests: Request[] = [];
  const names = new Map<string, string>();
  for (const session of evidence.sessions) {
    const usage = new Map(session.usageEntries.map((entry) => [entry.attemptId, entry]));
    for (const request of session.requests) {
      if (request.preparedAt === undefined || request.respondedAt === undefined) continue;
      const settled = request.attemptId === undefined ? undefined : usage.get(request.attemptId);
      const entry = settled?.coverage === "unmeasured" ? undefined : settled;
      const conversation = request.identity.conversationId;
      const group = conversation ?? `other requests (${request.model ?? "unknown model"})`;
      if (conversation && request.workflowAttemptId) names.set(conversation, `attempt ${request.workflowAttemptId}`);
      requests.push({
        group, label: group, kind: conversation === undefined || session.kind === "workflow" ? "background" : session.kind, startMs: request.preparedAt, endMs: request.respondedAt,
        outputTokens: entry?.tokens.output ?? 0, usd: entry?.price.kind === "priced" ? entry.price.estimatedUsd : null, model: request.model ?? "unknown model",
      });
    }
  }
  let unnamed = 0;
  const order = [...new Set([...requests].sort((left, right) => left.startMs - right.startMs).filter((request) => request.kind === "workflow-agent" || request.kind === "subagent").map((request) => request.group))];
  for (const group of order) if (!names.has(group)) names.set(group, `agent ${++unnamed}`);
  return phasesOf(requests.map((request) => ({ ...request, label: names.get(request.group) ?? request.group })));
}

const TranscriptLine = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Schema.Struct({
      input_tokens: Schema.Number, output_tokens: Schema.Number,
      cache_read_input_tokens: Schema.optionalKey(Schema.Number), cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
    })),
  })),
});
const AgentMeta = Schema.Struct({ description: Schema.optionalKey(Schema.String) });
const StreamResult = Schema.Struct({ type: Schema.Literal("result"), total_cost_usd: Schema.optionalKey(Schema.Number) });

/** Anthropic list prices keep these ratios to the input price for every Claude model, so a request's share of these
 *  weights is its share of the session's reported list cost. */
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } as const;

/** One assistant message per request: the transcript repeats a streamed message under one id, and its last copy
 *  carries the final usage. */
async function transcriptRequests(path: string, label: string, kind: RequestKind): Promise<(Request & { weight: number })[]> {
  const messages = new Map<string, Request & { weight: number }>();
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (line.trim() === "") continue;
    const decoded = Schema.decodeUnknownOption(TranscriptLine)(JSON.parse(line));
    if (decoded._tag === "None") continue;
    const { message, timestamp, type } = decoded.value;
    if (type !== "assistant" || !message?.id || !message.usage || !timestamp) continue;
    const at = Date.parse(timestamp);
    const usage = message.usage;
    const prior = messages.get(message.id);
    messages.set(message.id, {
      group: path, label, kind, startMs: prior?.startMs ?? at, endMs: at, outputTokens: usage.output_tokens, usd: null, model: message.model ?? "unknown model",
      weight: usage.input_tokens * WEIGHT.input + usage.output_tokens * WEIGHT.output
        + (usage.cache_read_input_tokens ?? 0) * WEIGHT.cacheRead + (usage.cache_creation_input_tokens ?? 0) * WEIGHT.cacheWrite,
    });
  }
  return [...messages.values()];
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** Claude Code phases from the retained transcript tree. A request's end is the time its message was written; its cost
 *  is its token-weight share of the session's reported list cost. */
export async function claudeCodePhases(runDirectory: string): Promise<Phase[]> {
  const transcripts = join(runDirectory, "transcripts");
  const top = await readdir(transcripts, { withFileTypes: true }).catch(() => []);
  const main = top.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (!main) return [];
  const all = await files(transcripts);
  const requests = await transcriptRequests(join(transcripts, main.name), "chat", "chat");
  for (const path of all.filter((candidate) => /\/subagents\/.*agent-[^/]+\.jsonl$/.test(candidate.split(sep).join("/")))) {
    const meta = await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8").then((text) => Schema.decodeUnknownOption(AgentMeta)(JSON.parse(text)), () => undefined);
    const label = meta?._tag === "Some" && meta.value.description ? meta.value.description : basename(path, ".jsonl");
    const kind = /\/subagents\/workflows\/wf_[^/]+\/agent-[^/]+\.jsonl$/.test(path.split(sep).join("/")) ? "workflow-agent" : "subagent";
    requests.push(...await transcriptRequests(path, label, kind));
  }
  const stream = await readFile(join(runDirectory, "stream.jsonl"), "utf8").catch(() => "");
  const result = stream.split("\n").filter(Boolean).flatMap((line) => {
    const decoded = Schema.decodeUnknownOption(StreamResult)(JSON.parse(line));
    return decoded._tag === "Some" && decoded.value.total_cost_usd !== undefined ? [decoded.value.total_cost_usd] : [];
  }).at(-1);
  const totalWeight = requests.reduce((total, request) => total + request.weight, 0);
  return phasesOf(requests.map((request) => ({ ...request, usd: result === undefined || totalWeight === 0 ? null : result * request.weight / totalWeight })));
}

async function runDirectories(artifacts: string): Promise<string[]> {
  const entries = await readdir(artifacts, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .map((entry) => entry.name).sort((left, right) => Number(left.slice(4)) - Number(right.slice(4))).map((name) => join(artifacts, name));
}

/** The phases and workflow-metric coverage of one cell. Flywheel's last run holds every earlier run of the same session.
 * Incomplete descendant discovery or missing request evidence leaves coverage unavailable without hiding retained phases. */
export async function cellPhases(cellDirectory: string): Promise<{ subject: "flywheel" | "claude-code"; phases: Phase[]; coverage: "complete" | "unavailable" } | undefined> {
  const runs = await runDirectories(join(cellDirectory, "artifacts"));
  const last = runs.at(-1);
  if (!last) return undefined;
  const evidence = await readFile(join(last, "evidence.json"), "utf8").catch(() => undefined);
  if (evidence !== undefined) {
    const decoded = decodeExecutionEvidence(JSON.parse(evidence));
    const phases = flywheelPhases(decoded);
    return { subject: "flywheel", phases, coverage: decoded.descendantDiscovery === "current-metadata" && phases.length > 0 ? "complete" : "unavailable" };
  }
  if ((await readdir(last)).includes("transcripts")) {
    const phases = await claudeCodePhases(last);
    return { subject: "claude-code", phases, coverage: phases.length > 0 ? "complete" : "unavailable" };
  }
  return undefined;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const dollars = (usd: number, unpriced: number) => `$${usd.toFixed(4)}${unpriced === 0 ? "" : ` (+${unpriced} unpriced)`}`;

/** Render every completed attempt's phases, then each treatment's mean time and cost before, during, and after its workflow. */
async function renderPhaseTimeline(directory: string): Promise<string> {
  const attempts = (await readFile(join(directory, "events.jsonl"), "utf8")).split("\n").filter(Boolean).flatMap((line) => {
    const decoded = Schema.decodeUnknownOption(CampaignAttemptSchema)(JSON.parse(line));
    return decoded._tag === "Some" ? [decoded.value] : [];
  });
  const lines = ["# Phase timeline", "", "Seconds from each cell's first model request. Claude Code cost is each request's token-weight share of the session's list cost.", ""];
  const totals = new Map<string, { cells: number; before: number; workflow: number; after: number; usd: number; unpriced: number }>();
  for (const attempt of attempts) {
    const cell = await cellPhases(join(directory, attempt.directory));
    if (!cell || cell.phases.length === 0) continue;
    const { treatment, task, repeat } = attempt.cell;
    lines.push(`## ${treatment} ${task} r${repeat} (${cell.subject})`, "", "| Phase | Kind | Start | End | Seconds | Requests | Output tokens | Cost | Models |", "|---|---|---|---|---|---|---|---|---|");
    for (const phase of cell.phases) {
      lines.push(`| ${phase.label} | ${phase.kind} | ${seconds(phase.startMs)} | ${seconds(phase.endMs)} | ${seconds(phase.endMs - phase.startMs)} | ${phase.requests} | ${phase.outputTokens} | ${dollars(phase.usd, phase.unpriced)} | ${phase.models.join(", ")} |`);
    }
    lines.push("");
    const chat = (label: string) => cell.phases.find((phase) => phase.label === label);
    const agents = cell.phases.filter((phase) => phase.kind === "workflow-agent");
    const total = totals.get(treatment) ?? { cells: 0, before: 0, workflow: 0, after: 0, usd: 0, unpriced: 0 };
    total.cells++;
    total.before += (chat(CHAT_BEFORE)?.endMs ?? 0);
    total.workflow += agents.length === 0 ? 0 : Math.max(...agents.map((phase) => phase.endMs)) - Math.min(...agents.map((phase) => phase.startMs));
    const after = chat(CHAT_AFTER);
    total.after += after ? after.endMs - Math.max(...agents.map((phase) => phase.endMs), after.startMs) : 0;
    total.usd += cell.phases.reduce((sum, phase) => sum + phase.usd, 0);
    total.unpriced += cell.phases.reduce((sum, phase) => sum + phase.unpriced, 0);
    totals.set(treatment, total);
  }
  lines.push("## Means", "", "| Treatment | Cells | Before launch (s) | Workflow (s) | After completion (s) | Cost |", "|---|---|---|---|---|---|");
  for (const [treatment, total] of totals) {
    lines.push(`| ${treatment} | ${total.cells} | ${seconds(total.before / total.cells)} | ${seconds(total.workflow / total.cells)} | ${seconds(total.after / total.cells)} | ${dollars(total.usd / total.cells, total.unpriced)} |`);
  }
  return [...lines, ""].join("\n");
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("Usage: phase-timeline.ts <results-directory>");
    process.exitCode = 1;
  } else renderPhaseTimeline(resolve(directory)).then(console.log, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
