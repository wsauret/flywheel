import { expect, spyOn, test } from "bun:test";
import type { FileSink } from "bun";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { OwnedProcess, OwnedProcessExit } from "../../../../../../../src/infra/supervision/launch/owned-subprocess.js";
import type { LauncherScope } from "../../../../../../../src/infra/process-supervisor.js";
import { acpQuestionForm } from "../../../../../../../src/protocol/rpc/acp.js";
import type { PendingQuestionView } from "../../../../../../../src/protocol/session/question-protocol-types.js";
import { workflowLaunchDecision } from "../../../../../../../src/orchestration/workflow-host/lifecycle/launch-origin.js";
import type { RuntimeSessionModelPlanResult } from "../../../../../../../src/protocol/auth/model-assignment-protocol-types.js";
import { temporaryDirectories } from "../../../../../../helpers/directories.js";
import { executeHeadlessBenchmark } from "../../../../../../../src/orchestration/modules/development/benchmark/execution/headless-execution.js";
import type { HeadlessBenchmarkExecution } from "../../../../../../../src/orchestration/modules/development/benchmark/execution/headless-execution-contract.js";
import * as sourceTreatment from "../../../../../../../bench/chat-ab/source-treatment.js";
import { resolveCampaignSubject, type CampaignInvocationCapture } from "../../../../../../../bench/chat-ab/campaign-subject.js";
import { chatLedger, type ChatCampaign } from "../../../../../../../bench/chat-ab/chat-store.js";
import { campaignHeadlessOutcome } from "../../../../../../../bench/chat-ab/campaign-execution.js";
import type { ConversationDedup } from "../../../../../../../src/orchestration/session/diagnostics/provider-request-audit-recorder.js";
import { providerRequestFacts } from "../../../../session/_provider-request-audit-fixtures.js";

const temporary = temporaryDirectories();
const plan: RuntimeSessionModelPlanResult = {
  sessionId: "root", profile: { persistedId: "Personal", effectiveId: "Personal" },
  assignments: [{ slot: { kind: "role", roleId: "chat" }, label: "Chat", model: "claude-sonnet-5.5", effort: "medium", modelSource: "explicit", matchesInheritedPair: false }],
  plans: [{ kind: "available", model: "claude-sonnet-5.5", candidates: [
    { kind: "singleton", providerId: "first", spendMode: "direct_api", wireModelId: "wire-one" },
    { kind: "singleton", providerId: "second", spendMode: "direct_api", wireModelId: "wire-two" },
  ] }],
};
const usage = (id: string) => ({
  attemptId: id, occurredAt: "2026-10-13T00:00:00.000Z", profileId: "Personal",
  attribution: { kind: "candidate", providerId: "second" }, spendMode: "direct_api",
  credentialLineage: "10000000-0000-4000-8000-000000000001", model: "actual-model",
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  classification: "real_spend", currency: "USD", coverage: "complete",
  price: { kind: "priced", estimatedUsd: 0.2, rateCard: {}, provenance: "fixture" },
});
const request = (id: string, outcome = "ok") => ({
  requestId: id, identity: { providerSessionKey: "safe-id" }, turn: 1, dispatchState: "dispatched",
  completionState: "terminal", purpose: "normal", model: "actual-model", accessProvider: "second",
  outcome, measurement: "available",
});
const evidence = {
  version: 2, projectRoot: "/scratch/project", rootSessionId: "root", descendantDiscovery: "current-metadata", metadataGaps: [],
  sessions: [
    { sessionId: "root", kind: "chat", requests: [request("parent-request")], usageEntries: [usage("00000000-0000-4000-8000-000000000001")] },
    { sessionId: "child", parentSessionId: "root", kind: "subagent", requests: [request("child-request"), request("failed-request", "stream_error")], usageEntries: [usage("00000000-0000-4000-8000-000000000002")] },
  ],
  accounting: { usage: "available", price: "estimate", providerInvoicedCost: "unavailable" },
};
const roles = { "workflow-agent": { model: "step-model", effort: "high" }, "brief.debug.investigate": { model: "investigate-model", effort: "medium" } };

async function toolAudit(offeredSession?: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const session of evidence.sessions) {
    const dedup: ConversationDedup = {};
    for (const row of session.requests) {
      const tools = (session.sessionId === offeredSession ? ["read", "subagent"] : ["read"]).map(name => ({
        name: `mcp__runtime__${name}`, executableId: name, registrationId: name, description: "", input_schema: { type: "object" },
      }));
      const facts = await providerRequestFacts({
        requestId: row.requestId, identity: row.identity, turn: 1, promptKind: "chat",
        systemPrompt: "system", messages: [], messageCount: 0, estimatedContextTokens: 0, attemptStaticTokens: 0, contextWindow: 100000,
        tools, omittedTools: [], model: "claude-sonnet-5.5", accessProvider: "anthropic_api", modelFamily: "anthropic", interactionProfileId: "default",
      }, dedup);
      for (const fact of facts) {
        if (fact.type === "model.requested") continue;
        const position = rows.length + 1;
        rows.push({ source: "store", id: `fact-${position}`, aggregateId: `session:${session.sessionId}`, sessionId: session.sessionId, position, seq: position, timestamp: position, ...fact });
      }
    }
  }
  return rows;
}

const designQuestion = (toolUseId: string): PendingQuestionView => ({
  kind: "question", toolUseId, timestamp: 0, questions: [{ question: "Proceed?", multiSelect: false, choices: [
    { kind: "option", choiceId: "choice-1", label: "Approve and continue" },
    { kind: "option", choiceId: "choice-2", label: "Revise design", requiresText: true },
    { kind: "freeform", label: "Other" },
  ] }],
});
const { decision } = workflowLaunchDecision({ source: { kind: "path", path: "/scratch/coding.workflow.yaml", definitionSha256: "a".repeat(64) }, name: "Coding" });
const launchQuestion = (toolUseId: string): PendingQuestionView => ({ kind: "question", toolUseId, timestamp: 0, questions: [{ question: decision.question, header: "Workflow", multiSelect: false, choices: [
  { kind: "option", ...decision.approve }, { kind: "option", ...decision.reject }, { kind: "freeform", label: "Other" },
] }] });
const text = (value: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });

/** One subject process's prompt: the updates it streams, the questions it asks as forms in order, and how it stops. */
interface PromptScript {
  readonly updates?: readonly unknown[];
  readonly forms?: readonly PendingQuestionView[];
  /** The question the session still has open, which a resume asks again. */
  readonly reask?: PendingQuestionView;
  readonly stopReason?: string;
  readonly promptFailure?: string;
}

/** A fake ACP v1 subject that answers the adapter's requests as headless chat does. */
function subject(options: PromptScript & {
  plan?: unknown; exitCode?: number; malformed?: string; evidence?: unknown; updateSessionId?: string;
  noMeta?: boolean; unsettled?: boolean; snapshotExitCode?: number; roles?: unknown; workflowsMode?: "on" | "ask" | "off"; ignoreConfig?: boolean;
  toolAudit?: readonly unknown[]; runs?: readonly PromptScript[];
} = {}) {
  const commands: unknown[] = [];
  const launches: { command: readonly string[]; env: unknown }[] = [];
  /** Whether each subject launch's auth snapshot existed when the subject started. */
  const staged: boolean[] = [];
  let terminated = 0;
  let closed = 0;
  let runs = 0;
  const artifactDir = temporary("headless-execution-");
  const children: OwnedProcess[] = [];
  const scope: LauncherScope = {
    open: () => scope,
    adoptOwned: async () => { throw new Error("no adoption"); },
    close: async () => {
      closed++;
      await Promise.all(children.map((child) => child.terminate()));
      return options.unsettled ? { settled: false, reason: "descendant remains" } : { settled: true };
    },
    spawnOwned: async (command, launchOptions) => {
      launches.push({ command, env: launchOptions?.env });
      const snapshotAt = command.indexOf("--auth-snapshot");
      if (snapshotAt >= 0) staged.push(existsSync(command[snapshotAt + 1]!));
      if (command.includes("snapshot-auth")) {
        await writeFile(command[command.indexOf("--output") + 1]!, "{}", { mode: 0o600 });
        const exited = Promise.resolve<OwnedProcessExit>({ code: options.snapshotExitCode ?? 0, signal: null, statusOf: "payload", ownership: "surrendered" });
        const once = (bytes: string) => new ReadableStream<Uint8Array>({ start(value) { value.enqueue(new TextEncoder().encode(bytes)); value.close(); } });
        const exporter: OwnedProcess = { pid: 1, token: "fake", stdin: undefined, stdout: once("Personal\n"), stderr: once(""), exited, terminate: async () => exited };
        return exporter;
      }
      const isEvidence = command.includes("evidence");
      const isSearch = command.includes("search");
      const script: PromptScript = isEvidence || isSearch ? {} : options.runs?.[runs++] ?? options;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const deferred = Promise.withResolvers<OwnedProcessExit>();
      let finished = false;
      let leftOpen = false;
      const emit = (record: unknown) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
      const finish = (code = 0) => {
        if (finished) return;
        finished = true;
        controller.close();
        deferred.resolve({ code, signal: null, statusOf: "payload", ownership: "surrendered" });
      };
      const configId = { model: "claude-sonnet-5.5", effort: "medium" };
      const settings = () => options.noMeta ? { configOptions: [] } : {
        configOptions: Object.entries(configId).map(([id, currentValue]) => ({ id, name: id, category: id === "model" ? "model" : "thought_level", type: "select", currentValue, options: [] })),
        _meta: { "dev.flywheel/settings": { modelPlan: options.plan ?? plan, roles: options.roles === undefined ? { assignments: roles } : options.roles, workflowsMode: options.workflowsMode ?? "on" } },
      };
      const forms = [...script.forms ?? []];
      let prompt: string | number | undefined;
      let asked = 0;
      const ask = (question: PendingQuestionView) => emit({ jsonrpc: "2.0", id: `flywheel-${++asked}`, method: "elicitation/create", params: acpQuestionForm(question, "root") });
      const answerPrompt = () => {
        const next = forms.shift();
        if (next) return ask(next);
        if (prompt === undefined) return;
        const id = prompt;
        prompt = undefined;
        if (script.promptFailure) emit({ jsonrpc: "2.0", id, error: { code: -32603, message: "subject detail", data: { failure: script.promptFailure } } });
        else emit({ jsonrpc: "2.0", id, result: { stopReason: script.stopReason ?? "end_turn", usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 } } });
      };
      const respond = (record: { id?: string | number; method?: string; params?: { configId?: string; value?: string; sessionId?: string }; result?: { action?: string } }) => {
        const { id } = record;
        if (record.method === undefined) {
          // The answer to a resumed question's form: the prompt answers that question.
          if (prompt === undefined) return;
          if (record.result?.action !== "accept") leftOpen = true;
          else emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "root", update: { sessionUpdate: "tool_call", toolCallId: "work", title: "Work", kind: "other", status: "completed" } } });
          if (record.result?.action !== "accept") forms.length = 0;
          return answerPrompt();
        }
        if (record.method === "initialize") emit({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "flywheel", title: "Flywheel", version: "0" }, authMethods: [] } });
        if (record.method === "session/new") emit({ jsonrpc: "2.0", id, result: { sessionId: "root", ...settings() } });
        if (record.method === "session/resume") {
          if (record.params?.sessionId !== "root") return emit({ jsonrpc: "2.0", id, error: { code: -32002, message: "Unknown session" } });
          emit({ jsonrpc: "2.0", id, result: settings() });
          if (script.reask) ask(script.reask);
        }
        if (record.method === "session/set_config_option") {
          if (!options.ignoreConfig && record.params?.configId && record.params.value) Object.assign(configId, { [record.params.configId]: record.params.value });
          emit({ jsonrpc: "2.0", id, result: settings() });
        }
        if (record.method === "session/prompt") {
          for (const update of script.updates ?? [text("do"), text("ne")]) {
            emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: options.updateSessionId ?? "root", update } });
          }
          prompt = id;
          answerPrompt();
        }
      };
      const sink = Bun.file(join(artifactDir, `stdin-${launches.length}.jsonl`)).writer();
      let stdinEnded = false;
      const stdin: FileSink = {
        write(value) {
          if (typeof value !== "string") throw new Error("fixture expects JSON-RPC strings");
          const bytesWritten = sink.write(value);
          const record = JSON.parse(value);
          commands.push(record);
          respond(record);
          return bytesWritten;
        },
        flush: () => sink.flush(),
        end(error) {
          const result = stdinEnded ? 0 : sink.end(error);
          stdinEnded = true;
          // Headless chat exits 0 when its work drained and 2 when a question stays open.
          if (!isEvidence && !isSearch) finish(options.exitCode ?? (leftOpen ? 2 : 0));
          return result;
        },
        start: (sinkOptions) => sink.start(sinkOptions),
        ref: () => sink.ref(),
        unref: () => sink.unref(),
      };
      const child: OwnedProcess = {
        pid: 1, token: "fake", stdin, stdout,
        stderr: new ReadableStream({ start(value) { value.enqueue(new TextEncoder().encode("diagnostic\n")); value.close(); } }),
        exited: deferred.promise,
        terminate: async () => { if (!finished) { terminated++; finish(143); } return deferred.promise; },
      };
      children.push(child);
      if (isEvidence) { emit(options.evidence ?? evidence); finish(); }
      else if (isSearch) {
        for (const row of options.toolAudit ?? []) {
          if (typeof row === "object" && row !== null && "type" in row && command.includes(String(row.type))) emit(row);
        }
        finish();
      }
      else if (options.malformed) controller!.enqueue(new TextEncoder().encode(options.malformed));
      return child;
    },
  };
  const methods = () => commands.flatMap((record) => typeof record === "object" && record !== null && "method" in record ? [record.method] : []);
  return {
    commands, launches, staged, artifactDir, methods, terminated: () => terminated, closed: () => closed,
    input: {
      launcher: scope, commandPrefix: ["subject"], projectRoot: "/scratch/project", env: { HOME: "/scratch/home" },
      profile: "Personal", model: "claude-sonnet-5-5", effort: "medium" as const, artifactDir, message: "task",
    },
  };
}

test.each(["on", "ask", "off"] as const)("checks Workflows %s before submitting a pinned cell and records the descriptor", async (workflowsMode) => {
  const fixture = subject({ workflowsMode });
  const result = await executeHeadlessBenchmark({ ...fixture.input, requireWorkflowsOn: true });
  expect(result.workflowsMode).toBe(workflowsMode);
  expect(JSON.parse(await readFile(result.artifacts.modules!.path, "utf8"))).toEqual({ workflowsMode });
  if (workflowsMode === "on") expect(result.outcome).toBe("complete");
  else {
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("Workflows must be On");
    expect(fixture.methods()).not.toContain("session/prompt");
  }
});

test("accepts a completed execution only after verified settings and the turn's final message", async () => {
  const fixture = subject({ updates: [text("draft"), { sessionUpdate: "tool_call", toolCallId: "t", title: "Read", kind: "read", status: "completed" }, text("do"),
    { sessionUpdate: "usage_update", used: 1, size: 10 }, text("ne")] });
  const result = await executeHeadlessBenchmark({ ...fixture.input, message: "task" });
  expect(result.outcome).toBe("complete");
  expect(fixture.commands).toMatchObject([
    { method: "initialize", params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } } },
    { method: "session/new", params: { cwd: "/scratch/project", mcpServers: [] } },
    { method: "session/set_config_option", params: { sessionId: "root", configId: "model", value: "claude-sonnet-5.5" } },
    { method: "session/set_config_option", params: { sessionId: "root", configId: "effort", value: "medium" } },
    { method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text: "task" }] } },
  ]);
  expect(result.handoff).toEqual({ summary: "done" });
  expect(result.plan).toEqual(plan);
  expect(result.evidence).toMatchObject({ kind: "observed", value: evidence, childSessionCount: 1, requestCount: 3, parentRequestCount: 1 });
  expect(result.totalAccounting.estimatedUsd).toEqual({ kind: "observed", value: 0.4 });
  expect(result.parentAccounting.estimatedUsd).toEqual({ kind: "observed", value: 0.2 });
  const snapshot = fixture.launches[0]!.command.at(-1)!;
  expect(basename(dirname(snapshot))).toStartWith("flywheel-auth-bundle-");
  expect(fixture.launches).toEqual([
    { command: ["subject", "headless", "snapshot-auth", "--auth-profile", "Personal", "--output", snapshot], env: { HOME: "/scratch/home" } },
    { command: ["subject", "--headless", "--acp", "--auth-snapshot", snapshot, "--project-root", "/scratch/project"], env: { HOME: "/scratch/home" } },
    { command: ["subject", "events", "evidence", "--session", "root", "--project-root", "/scratch/project"], env: { HOME: "/scratch/home" } },
  ]);
  expect(fixture.staged).toEqual([true]);
  expect(existsSync(dirname(snapshot))).toBe(false);
  expect(fixture.closed()).toBe(1);
  for (const artifact of Object.values(result.artifacts)) {
    const bytes = await readFile(artifact.path);
    expect(artifact.bytes).toBe(bytes.length);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  expect(await readFile(join(fixture.artifactDir, "stderr.txt"), "utf8")).toBe("diagnostic\n");
});

test("preflight verifies settings, closes stdin, and applies confinement to both commands without sending work", async () => {
  const fixture = subject();
  const { message: _, ...input } = fixture.input;
  const result = await executeHeadlessBenchmark({ ...input, wrapCommand: (command) => ["sandbox", ...command] });
  expect(result.outcome).toBe("preflight");
  expect(result.handoff).toBeUndefined();
  expect(fixture.methods()).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option"]);
  expect(fixture.launches.every((launch) => launch.command[0] === "sandbox")).toBe(true);
  expect(fixture.launches[1]?.command).toEqual(["sandbox", "subject", "--headless", "--acp", "--auth-snapshot", fixture.launches[0]!.command.at(-1)!, "--project-root", "/scratch/project"]);
});

test("answers each form through the caller's policy and leaves a declined question open", async () => {
  const forms: string[] = [];
  const fixture = subject({ forms: [launchQuestion("launch"), designQuestion("design")] });
  const result = await executeHeadlessBenchmark({ ...fixture.input, answerQuestion: (form) => {
    forms.push(form.toolCallId);
    return form.toolCallId === "launch" ? { q1: "approve" } : undefined;
  } });
  expect(forms).toEqual(["launch", "design"]);
  expect(fixture.commands).toContainEqual({ jsonrpc: "2.0", id: "flywheel-1", result: { action: "accept", content: { q1: "approve" } } });
  expect(fixture.commands).toContainEqual({ jsonrpc: "2.0", id: "flywheel-2", result: { action: "cancel" } });
  expect(result).toMatchObject({ outcome: "input_required", exitCode: 2 });
  expect(result.handoff).toBeUndefined();
});

test("resumes the named session in a new process, and its prompt answers the question the resume asks again", async () => {
  const policy: string[] = [];
  const fixture = subject({ reask: designQuestion("decision") });
  const result = await executeHeadlessBenchmark({ ...fixture.input, sessionId: "root", answers: "decision", message: "Try the smaller fix.", answerQuestion: (form) => {
    policy.push(form.toolCallId);
    return { q1: "choice-1" };
  } });
  expect(result.outcome).toBe("complete");
  expect(policy).toEqual([]);
  expect(fixture.launches[1]?.command).toEqual(["subject", "--headless", "--acp", "--auth-snapshot", fixture.launches[0]!.command.at(-1)!, "--project-root", "/scratch/project"]);
  expect(fixture.staged).toEqual([true]);
  expect(fixture.commands[1]).toMatchObject({ method: "session/resume", params: { sessionId: "root", cwd: "/scratch/project" } });
  // The resumed form is left open before the prompt, which the subject would refuse while the form runs.
  const reply = fixture.commands.findIndex((record) => JSON.stringify(record) === JSON.stringify({ jsonrpc: "2.0", id: "flywheel-1", result: { action: "cancel" } }));
  const prompt = fixture.commands.findIndex((record) => typeof record === "object" && record !== null && "method" in record && record.method === "session/prompt");
  expect(reply).toBeGreaterThan(0);
  expect(prompt).toBeGreaterThan(reply);
});

test("prepares once, resumes after an inherited role edit, and retains each cell's current roles", async () => {
  const hash = "a".repeat(64);
  const source = { revision: "revision", tree: hash, packageIdentity: hash, lockIdentity: hash, dependencyIdentity: hash };
  const resolve = spyOn(sourceTreatment, "resolveSourceTreatment").mockResolvedValue(source);
  const prepare = spyOn(sourceTreatment, "prepareSourceTreatment").mockResolvedValue({
    version: 1, source, sourceIdentity: hash, harnessIdentity: hash, installedDependencyIdentity: hash, root: "/scratch/source",
  });
  try {
    const run = async () => { throw new Error("Unexpected command"); };
    const resolved = await resolveCampaignSubject({ revision: "revision" }, { model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal" }, run);
    const prepared = await resolved.prepare("/scratch/source");
    const directory = temporary("role-resume-");
    let settings: string | undefined;
    const manifest = (identity: string): ChatCampaign => ({
      kind: "chat-ab", version: 2, name: "roles", model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal",
      answers: "approve-root-workflow-launch", infrastructureIdentity: hash, repeats: 2, createdAt: "now",
      treatments: [{ ...prepared.record("a", identity), arm: { id: "baseline", identity: null, invokeSkill: null }, model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal" }],
      tasks: [{ id: "task", stratum: "bug", contentIdentity: hash, timeoutMs: 1000 }],
    });
    for (const [repeat, model] of ["step-model", "changed"].entries()) {
      const current = { "workflow-agent": { model, effort: "high" } };
      const fixture = subject({ roles: { assignments: current } });
      const context = { launcher: fixture.input.launcher, projectRoot: fixture.input.projectRoot, artifactDir: join(directory, model), env: fixture.input.env, wrapCommand: (command: readonly string[]) => command };
      const identity = await prepared.preflight(context);
      if (settings !== undefined) expect(identity).toBe(settings);
      settings = identity;
      const store = await chatLedger.open(directory, manifest(identity));
      expect(chatLedger.pending(store.manifest, await store.load()).map((cell) => cell.repeat)).toContain(repeat);
      const result = await prepared.execute(context, "task", { executions: [], questionArtifacts: new Map(), answered: new Set(), approvals: 0 });
      expect(result.outcome).toBe("complete");
      expect(JSON.parse(await readFile(result.artifacts.roles!.path, "utf8"))).toEqual(current);
      expect(fixture.commands).toContainEqual(expect.objectContaining({ method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text: "task" }] } }));
      const attempt = { kind: "attempt" as const, attemptId: model, cell: { treatment: "a", task: "task", repeat }, at: "now", directory: model };
      await store.append(attempt);
      await store.append(campaignHeadlessOutcome(directory, attempt, [result], 0, { grade: null, report: null, diff: null }));
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    const pinned = await (await resolveCampaignSubject({ revision: "revision" }, { model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal", roles: { explorer: { model: "pinned" } } }, run)).prepare("/scratch/pinned");
    const fixture = subject();
    const pinnedIdentity = await pinned.preflight({ launcher: fixture.input.launcher, projectRoot: fixture.input.projectRoot, artifactDir: fixture.artifactDir, env: fixture.input.env, wrapCommand: (command) => command });
    expect(pinnedIdentity).not.toBe(settings);
    const disabled = await (await resolveCampaignSubject({ revision: "revision", disabledTools: ["subagent"] }, { model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal" }, run)).prepare("/scratch/disabled");
    expect(disabled.record("disabled", hash)).toMatchObject({ disabledTools: ["subagent"] });
    const preflight = subject();
    const preflightIdentity = await disabled.preflight({ launcher: preflight.input.launcher, projectRoot: preflight.input.projectRoot, artifactDir: preflight.artifactDir, env: preflight.input.env, wrapCommand: command => command });
    expect(preflightIdentity).not.toBe(settings);
    expect(preflight.launches[1]?.command).toContain("--disable-tool");
    expect(preflight.launches.some(launch => launch.command.includes("search"))).toBe(false);
    for (const offered of ["none", "root", "child", "missing"]) {
      const checked = subject({ toolAudit: offered === "missing" ? [] : await toolAudit(offered),
        evidence: { ...evidence, sessions: evidence.sessions.map(session => session.sessionId === "child" ? { ...session, kind: "workflow-agent" } : session) } });
      const executions: HeadlessBenchmarkExecution[] = [];
      const result = await disabled.execute({
        launcher: checked.input.launcher, projectRoot: checked.input.projectRoot, artifactDir: checked.artifactDir, env: checked.input.env, wrapCommand: command => command,
      }, "task", { executions, questionArtifacts: new Map(), answered: new Set(), approvals: 0 });
      expect(result.outcome).toBe(offered === "none" ? "complete" : "failed");
      expect(executions).toEqual([result]);
      expect(checked.launches[1]?.command).toContain("--disable-tool");
      if (offered === "missing") expect(result.reason).toContain("could not be verified");
      else {
        const proof = JSON.parse(await readFile(result.artifacts.disabledTools!.path, "utf8"));
        expect(proof.requests).toHaveLength(3);
        expect(proof.violations.length).toBe(offered === "none" ? 0 : offered === "root" ? 1 : 2);
      }
    }
  } finally {
    resolve.mockRestore();
    prepare.mockRestore();
  }
});

test("delivers a challenge as a resumed prompt that answers the open design question, then approves the revised design once", async () => {
  const hash = "a".repeat(64);
  const source = { revision: "revision", tree: hash, packageIdentity: hash, lockIdentity: hash, dependencyIdentity: hash };
  const resolve = spyOn(sourceTreatment, "resolveSourceTreatment").mockResolvedValue(source);
  const prepare = spyOn(sourceTreatment, "prepareSourceTreatment").mockResolvedValue({
    version: 1, source, sourceIdentity: hash, harnessIdentity: hash, installedDependencyIdentity: hash, root: "/scratch/source",
  });
  try {
    const run = async () => { throw new Error("Unexpected command"); };
    const prepared = await (await resolveCampaignSubject({ revision: "revision" }, { model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal" }, run)).prepare("/scratch/source");
    const fixture = subject({ runs: [
      { forms: [launchQuestion("launch"), designQuestion("design")] },
      { reask: designQuestion("design"), forms: [designQuestion("revised"), designQuestion("again")] },
    ] });
    const capture: CampaignInvocationCapture = { executions: [], questionArtifacts: new Map(), answered: new Set(), approvals: 0 };
    const context = { launcher: fixture.input.launcher, projectRoot: fixture.input.projectRoot, artifactDir: fixture.artifactDir, env: fixture.input.env, wrapCommand: (command: readonly string[]) => command };
    const result = await prepared.execute(context, "task", capture, "Try the smaller fix.");
    expect(capture.executions.map((execution) => execution.outcome)).toEqual(["input_required", "input_required"]);
    expect(result).toBe(capture.executions[1]!);
    expect(capture.challenge).toEqual({ delivered: "revise-design" });
    // The launch and the revised design are approved; the challenged design is revised, and a second design stays open.
    expect(capture.approvals).toBe(2);
    expect(capture.answered).toEqual(new Set(["launch", "design", "revised"]));
    const mains = fixture.launches.filter((launch) => launch.command.includes("--acp"));
    expect(mains).toHaveLength(2);
    // The snapshot is consumed on use, so the resumed run exports a fresh one.
    expect(fixture.staged).toEqual([true, true]);
    expect(new Set(mains.map((launch) => launch.command[launch.command.indexOf("--auth-snapshot") + 1])).size).toBe(2);
    expect(fixture.commands).toContainEqual(expect.objectContaining({ method: "session/resume", params: { sessionId: "root", cwd: "/scratch/project" } }));
    expect(fixture.commands).toContainEqual(expect.objectContaining({ method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text: "Try the smaller fix." }] } }));
    expect([...capture.questionArtifacts.keys()].sort()).toEqual([0, 1]);
    expect(capture.questionArtifacts.get(0)).toMatchObject({ questions: { path: join(fixture.artifactDir, "run-0", "questions.jsonl") }, challengeBefore: {} });
    expect(capture.questionArtifacts.get(1)).toMatchObject({ questions: { path: join(fixture.artifactDir, "run-1", "questions.jsonl") }, challengeAfter: {} });
    expect(capture.challengeReply?.path).toBe(join(fixture.artifactDir, "challenge-reply.md"));
  } finally {
    resolve.mockRestore();
    prepare.mockRestore();
  }
});

test.each([null, { "workflow-agent": { model: "step-model" } }])("refuses unavailable or malformed role evidence before submitting candidate work", async (snapshot) => {
  const fixture = subject({ roles: snapshot });
  const result = await executeHeadlessBenchmark({ ...fixture.input, inspectRoles: true });
  expect(result.outcome).toBe("failed");
  expect(fixture.methods()).not.toContain("session/prompt");
});

test("a refused auth snapshot export launches no subject and leaves no stage", async () => {
  const fixture = subject({ snapshotExitCode: 1 });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result).toMatchObject({ outcome: "failed", reason: "subject auth snapshot export failed" });
  expect(fixture.launches).toHaveLength(1);
  expect(existsSync(dirname(fixture.launches[0]!.command.at(-1)!))).toBe(false);
});

test("refuses a result when execution ownership remains unsettled", async () => {
  const fixture = subject({ unsettled: true });
  await expect(executeHeadlessBenchmark(fixture.input)).rejects.toThrow("benchmark execution ownership unsettled: descendant remains");
  expect(fixture.closed()).toBe(1);
});

test.each([
  { name: "input_required", script: { forms: [designQuestion("design")] } },
  { name: "incomplete", script: { updates: [] } },
  { name: "incomplete", script: { stopReason: "cancelled" } },
  { name: "failed", script: { promptFailure: "api_error" } },
])("retains observed usage for $name without answering a question", async ({ name, script }) => {
  const fixture = subject(script);
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe(name);
  expect(result.handoff).toBeUndefined();
  expect(result.totalAccounting.tokens).toEqual({ kind: "observed", value: 30 });
  if (name === "failed") expect(result.reason).toBe("subject turn failed (api_error)");
});

test.each([
  { profile: { persistedId: "Personal", effectiveId: "Other" } },
  { assignments: [{ ...plan.assignments[0], model: "other" }] },
  { assignments: [{ ...plan.assignments[0], effort: "high" }] },
  { plans: [{ kind: "unavailable", model: "claude-sonnet-5.5", reason: "offering absent", missing: "offering" }] },
])("refused public plan prevents candidate work", async (patch) => {
  const fixture = subject({ plan: { ...plan, ...patch } });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("failed");
  expect(fixture.methods()).not.toContain("session/prompt");
  expect(result.plan).toMatchObject(patch);
  expect(fixture.terminated()).toBe(1);
  expect(result.evidence.kind).toBe("observed");
});

test.each([{ noMeta: true }, { ignoreConfig: true }])("a subject that does not show or apply the pinned settings refuses before candidate work", async (options) => {
  const fixture = subject(options);
  const result = await executeHeadlessBenchmark({ ...fixture.input, model: "gpt-6.2-sol" });
  expect(result.outcome).toBe("failed");
  expect(result.plan).toBeUndefined();
  expect(fixture.methods()).not.toContain("session/prompt");
  expect(fixture.terminated()).toBe(1);
  expect(result.evidence.kind).toBe("observed");
});

test.each(['{"jsonrpc":"1.0","id":1,"result":{}}\n', "not-json\n"])("terminates invalid protocol and retains raw bytes", async (malformed) => {
  const fixture = subject({ malformed });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("failed");
  expect(fixture.terminated()).toBe(1);
  expect(await readFile(join(fixture.artifactDir, "stdout.jsonl"), "utf8")).toContain(malformed);
  expect(fixture.methods()).not.toContain("session/prompt");
});

test.each([{ updateSessionId: "other" }, { exitCode: 2 }, { stopReason: "refusal" }])("does not accept an unproven completion", async (options) => {
  const fixture = subject(options);
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).not.toBe("complete");
  expect(result.handoff).toBeUndefined();
  expect(result.evidence.kind).toBe("observed");
});

test.each([
  { ...evidence, descendantDiscovery: "incomplete", metadataGaps: [{ sessionId: "missing-child", kind: "missing", scope: "descendant" }] },
  { ...evidence, descendantDiscovery: "incomplete", metadataGaps: [{ sessionId: "corrupt-session", kind: "corrupt", scope: "workspace" }] },
])("incomplete descendant discovery preserves parent usage but not tree totals or counts", async (partial) => {
  const fixture = subject({ evidence: partial });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("complete");
  expect(result.evidence).toMatchObject({ kind: "unavailable" });
  expect(result.totalAccounting.estimatedUsd.kind).toBe("unavailable");
  expect(result.totalAccounting.tokens.kind).toBe("unavailable");
  expect(result.parentAccounting.estimatedUsd).toEqual({ kind: "observed", value: 0.2 });
  expect(result.parentAccounting.tokens).toEqual({ kind: "observed", value: 15 });
  expect("requestCount" in result.evidence).toBe(false);
  expect("childSessionCount" in result.evidence).toBe(false);
  expect(JSON.parse(await readFile(result.artifacts.evidence!.path, "utf8"))).toEqual(partial);
});

test("unavailable evidence does not invent zero accounting or request counts", async () => {
  const fixture = subject({ evidence: { ...evidence, version: 3 } });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("complete");
  expect(result.evidence).toMatchObject({ kind: "unavailable" });
  expect(result.totalAccounting.estimatedUsd.kind).toBe("unavailable");
  expect(result.parentAccounting.tokens.kind).toBe("unavailable");
  expect("requestCount" in result.evidence).toBe(false);
  expect(await readFile(join(fixture.artifactDir, "evidence.json"), "utf8")).toContain('"version":3');
});
