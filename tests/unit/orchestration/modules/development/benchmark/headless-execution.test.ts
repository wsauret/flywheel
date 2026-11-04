import { expect, spyOn, test } from "bun:test";
import type { FileSink } from "bun";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Schema } from "effect";
import type { OwnedProcess, OwnedProcessExit } from "../../../../../../src/infra/owned-subprocess.js";
import type { LauncherScope } from "../../../../../../src/infra/process-supervisor.js";
import type { FrontendMutation } from "../../../../../../src/protocol/app-service-types.js";
import type { RuntimeSessionModelPlanResult } from "../../../../../../src/protocol/model-assignment-protocol-types.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { executeHeadlessBenchmark } from "../../../../../../src/orchestration/modules/development/benchmark/headless-execution.js";
import { HeadlessBenchmarkExecutionSchema, type HeadlessBenchmarkExecution } from "../../../../../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import * as sourceTreatment from "../../../../../../bench/chat-ab/source-treatment.js";
import { resolveCampaignSubject } from "../../../../../../bench/chat-ab/campaign-subject.js";
import { chatLedger, type ChatCampaign } from "../../../../../../bench/chat-ab/chat-store.js";
import { campaignHeadlessOutcome } from "../../../../../../bench/chat-ab/campaign-execution.js";
import { buildProviderRequestFacts, type ConversationDedup } from "../../../../../../src/orchestration/session/provider-request-audit-recorder.js";

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

function toolAudit(offeredSession?: string) {
  let position = 0;
  return evidence.sessions.flatMap(session => {
    let dedup: ConversationDedup = {};
    return session.requests.flatMap(row => {
      const tools = (session.sessionId === offeredSession ? ["read", "subagent"] : ["read"]).map(name => ({
        name: `mcp__runtime__${name}`, executableId: name, registrationId: name, description: "", input_schema: { type: "object" },
      }));
      const built = buildProviderRequestFacts({
        requestId: row.requestId, identity: row.identity, turn: 1, promptKind: "chat",
        systemPrompt: "system", messages: [], messageCount: 0, estimatedContextTokens: 0, attemptStaticTokens: 0, contextWindow: 100000,
        tools, omittedTools: [], model: "claude-sonnet-5.5", accessProvider: "anthropic_api", modelFamily: "anthropic", interactionProfileId: "default",
        contextApplication: { identity: `context-${session.sessionId}`, applications: [{ applicationId: `application-${session.sessionId}`, transformerId: "transformer", seam: "modelContext", order: 1, outcome: "applied", inputHash: "a".repeat(64), outputHash: "b".repeat(64) }] },
      }, dedup);
      dedup = built.dedupAdvance;
      return built.facts.filter(fact => fact.type !== "model.requested").map(fact => ({
        source: "store", id: `fact-${++position}`, aggregateId: `session:${session.sessionId}`, sessionId: session.sessionId, position, seq: position, timestamp: position, ...fact,
      }));
    });
  });
}

function subject(options: {
  plan?: unknown; outcome?: string; handoff?: boolean; exitCode?: number; malformed?: string; evidence?: unknown;
  outcomeSessionId?: string; events?: readonly unknown[]; readyThenMalformed?: boolean; taskRefused?: boolean;
  planRefused?: boolean; unsettled?: boolean; roles?: unknown; workflowsMode?: "on" | "ask" | "off";
  toolAudit?: readonly unknown[];
} = {}) {
  const commands: unknown[] = [];
  const launches: { command: readonly string[]; env: unknown }[] = [];
  let terminated = 0;
  let closed = 0;
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
      const isEvidence = command.includes("evidence");
      const isSearch = command.includes("search");
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const deferred = Promise.withResolvers<OwnedProcessExit>();
      let finished = false;
      const emit = (record: unknown) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
      const finish = (code = 0) => {
        if (finished) return;
        finished = true;
        stdin.end();
        controller.close();
        deferred.resolve({ code, signal: null, statusOf: "payload", ownership: "surrendered" });
      };
      const emitOutcome = (preflight = false) => {
        emit({ version: 1, type: "outcome", sessionId: options.outcomeSessionId ?? "root", outcome: options.outcome ?? "complete",
          ...(!preflight && options.handoff !== false ? { handoff: { summary: "done", verified: "yes", custom: { value: 1 } } } : {}) });
        // The headless contract's exit code for each outcome (run-headless-chat.ts).
        const outcome = options.outcome ?? "complete";
        finish(options.exitCode ?? (outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2));
      };
      const sink = Bun.file(join(artifactDir, `stdin-${launches.length}.jsonl`)).writer();
      let stdinEnded = false;
      const stdin: FileSink = {
        write(value) {
          if (typeof value !== "string") throw new Error("fixture expects JSONL strings");
          const bytesWritten = sink.write(value);
          const record = JSON.parse(value);
          commands.push(record);
          if (record.id === "settings") emit({ version: 1, type: "result", id: record.id, result: { label: "model" } });
          if (record.id === "plan") {
            if (options.planRefused) emit({ version: 1, type: "error", id: "plan", error: "unsupported query" });
            else emit({ version: 1, type: "result", id: record.id, result: options.plan ?? plan });
          }
          if (record.id === "roles") emit({ version: 1, type: "result", id: record.id, result: options.roles ?? { snapshotPosition: 1, views: [{ sessionId: "root", view: { assignments: roles } }] } });
          if (record.id === "modules") emit({ version: 1, type: "result", id: record.id, result: { snapshotPosition: 1, capabilities: {
            capabilities: [], moduleIds: [], descriptorIdentity: "fixture", modules: [], warnings: [],
            requireWorkflowConfirmation: options.workflowsMode === "ask", workflowsMode: options.workflowsMode ?? "on",
            persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
          } } });
          if (record.id === "task") {
            for (const event of options.events ?? []) emit({ version: 1, type: "event", event });
            emit({ version: 1, type: "result", id: "task", result: options.taskRefused ? { ok: false, error: "refused" } : { ok: true } });
            emitOutcome();
          }
          return bytesWritten;
        },
        flush: () => sink.flush(),
        end(error) {
          const result = stdinEnded ? 0 : sink.end(error);
          stdinEnded = true;
          if (!finished && !isEvidence && !isSearch) emitOutcome(true);
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
      else {
        if (!options.malformed || options.readyThenMalformed) emit({ version: 1, type: "ready", sessionId: "root" });
        if (options.malformed) controller!.enqueue(new TextEncoder().encode(options.malformed));
      }
      return child;
    },
  };
  return {
    commands, launches, artifactDir, terminated: () => terminated, closed: () => closed,
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
  expect(JSON.parse(await readFile(result.artifacts.modules!.path, "utf8")).capabilities.workflowsMode).toBe(workflowsMode);
  if (workflowsMode === "on") expect(result.outcome).toBe("complete");
  else {
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("Workflows must be On");
    expect(fixture.commands.some((record) => typeof record === "object" && record !== null && "id" in record && record.id === "task")).toBe(false);
  }
});

test("accepts a completed execution only after verified settings and an accepted handoff", async () => {
  const fixture = subject();
  const result = await executeHeadlessBenchmark({ ...fixture.input, message: "task" });
  expect(result.outcome).toBe("complete");
  expect(fixture.commands.slice(0, 3)).toMatchObject([
    { id: "settings", command: { type: "model.save_effort", scope: { kind: "session", sessionId: "root" }, model: "claude-sonnet-5.5", effort: "medium" } },
    { id: "plan", query: { type: "sessionModelPlan", sessionId: "root" } },
    { id: "task", command: { type: "session.send", sessionId: "root", input: "task" } },
  ]);
  expect(result.handoff).toEqual({ summary: "done", verified: "yes", custom: { value: 1 } });
  expect(result.plan).toEqual(plan);
  expect(result.evidence).toMatchObject({ kind: "observed", value: evidence, childSessionCount: 1, requestCount: 3, parentRequestCount: 1 });
  expect(result.totalAccounting.estimatedUsd).toEqual({ kind: "observed", value: 0.4 });
  expect(result.parentAccounting.estimatedUsd).toEqual({ kind: "observed", value: 0.2 });
  expect(fixture.launches).toEqual([
    { command: ["subject", "--headless", "--one-shot", "--project-root", "/scratch/project"], env: { HOME: "/scratch/home", FLYWHEEL_AUTH_PROFILE: "Personal" } },
    { command: ["subject", "events", "evidence", "--session", "root", "--project-root", "/scratch/project"], env: { HOME: "/scratch/home", FLYWHEEL_AUTH_PROFILE: "Personal" } },
  ]);
  expect(fixture.closed()).toBe(1);
  Schema.decodeUnknownSync(HeadlessBenchmarkExecutionSchema, { onExcessProperty: "error" })(result);
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
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.launches.every((launch) => launch.command[0] === "sandbox")).toBe(true);
  // One-shot reports EOF without submitted work as incomplete, so preflight must run persistent.
  expect(fixture.launches[0]?.command).toEqual(["sandbox", "subject", "--headless", "--project-root", "/scratch/project"]);
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
      const fixture = subject({ roles: { snapshotPosition: 1, views: [{ sessionId: "root", view: { assignments: current } }] } });
      const context = { launcher: fixture.input.launcher, projectRoot: fixture.input.projectRoot, artifactDir: join(directory, model), env: fixture.input.env, wrapCommand: (command: readonly string[]) => command };
      const identity = await prepared.preflight(context);
      if (settings !== undefined) expect(identity).toBe(settings);
      settings = identity;
      const store = await chatLedger.open(directory, manifest(identity));
      expect(chatLedger.pending(store.manifest, await store.load()).map((cell) => cell.repeat)).toContain(repeat);
      const result = await prepared.execute(context, "task", { executions: [], questionArtifacts: new Map(), answered: new Set(), approvals: 0 });
      expect(result.outcome).toBe("complete");
      expect(JSON.parse(await readFile(result.artifacts.roles!.path, "utf8"))).toEqual(current);
      expect(fixture.commands).toContainEqual({ version: 1, type: "dispatch", id: "task", command: { type: "session.send", sessionId: "root", input: "task" } });
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
    expect(preflight.launches[0]?.command).toContain("--disable-tool");
    expect(preflight.launches.some(launch => launch.command.includes("search"))).toBe(false);
    for (const offered of ["none", "root", "child", "missing"]) {
      const checked = subject({ toolAudit: offered === "missing" ? [] : toolAudit(offered),
        evidence: { ...evidence, sessions: evidence.sessions.map(session => session.sessionId === "child" ? { ...session, kind: "workflow-agent" } : session) } });
      const executions: HeadlessBenchmarkExecution[] = [];
      const result = await disabled.execute({
        launcher: checked.input.launcher, projectRoot: checked.input.projectRoot, artifactDir: checked.artifactDir, env: checked.input.env, wrapCommand: command => command,
      }, "task", { executions, questionArtifacts: new Map(), answered: new Set(), approvals: 0 });
      expect(result.outcome).toBe(offered === "none" ? "complete" : "failed");
      expect(executions).toEqual([result]);
      expect(checked.launches[0]?.command).toContain("--disable-tool");
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

test.each([
  { snapshotPosition: 1, views: [{ sessionId: "root", view: null }] },
  { snapshotPosition: 1, views: [{ sessionId: "root", view: { "workflow-agent": { model: "step-model" } } }] },
])("refuses unavailable or malformed role evidence before submitting candidate work", async (snapshot) => {
  const fixture = subject({ roles: snapshot });
  const result = await executeHeadlessBenchmark({ ...fixture.input, inspectRoles: true });
  expect(result.outcome).toBe("failed");
  expect(fixture.commands.some((record) => typeof record === "object" && record !== null && "id" in record && record.id === "task")).toBe(false);
});

test("refuses a result when execution ownership remains unsettled", async () => {
  const fixture = subject({ unsettled: true });
  await expect(executeHeadlessBenchmark(fixture.input)).rejects.toThrow("benchmark execution ownership unsettled: descendant remains");
  expect(fixture.closed()).toBe(1);
});

test("continues only the named existing session with the caller's explicit public question answer", async () => {
  const fixture = subject();
  const { message: _, ...input } = fixture.input;
  const questionAnswer: Extract<FrontendMutation, { type: "question.answer" }> = {
    type: "question.answer", sessionId: "root", toolUseId: "decision",
    answers: { Mode: { kind: "choice", selections: [{ choiceId: "workflow" }], text: "Approved workflow" } },
  };
  const result = await executeHeadlessBenchmark({ ...input, sessionId: "root", questionAnswer });
  expect(result.outcome).toBe("complete");
  expect(fixture.launches[0]?.command).toEqual(["subject", "--headless", "--one-shot", "--session", "root", "--project-root", "/scratch/project"]);
  expect(fixture.commands[2]).toEqual({ version: 1, type: "dispatch", id: "task", command: questionAnswer });
});

test.each(["input_required", "incomplete", "failed"])("retains observed usage for %s without answering a question", async (outcome) => {
  const fixture = subject({ outcome, handoff: false });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe(outcome);
  expect(result.handoff).toBeUndefined();
  expect(result.totalAccounting.tokens).toEqual({ kind: "observed", value: 30 });
  expect(fixture.commands).toHaveLength(3);
  expect((await readFile(join(fixture.artifactDir, "stdout.jsonl"), "utf8"))).toContain(`"outcome":"${outcome}"`);
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
  expect(fixture.commands).toHaveLength(2);
  expect(result.plan).toMatchObject(patch);
  expect(fixture.terminated()).toBe(1);
  expect(result.evidence.kind).toBe("observed");
});

test("a subject without the public settings capability refuses before candidate work", async () => {
  const fixture = subject({ planRefused: true });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("failed");
  expect(result.plan).toBeUndefined();
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.terminated()).toBe(1);
  expect(result.evidence.kind).toBe("observed");
});

test.each(['{"version":2,"type":"ready","sessionId":"root"}\n', "not-json\n"])("terminates invalid protocol and retains raw bytes", async (malformed) => {
  const fixture = subject({ malformed, readyThenMalformed: true });
  const result = await executeHeadlessBenchmark(fixture.input);
  expect(result.outcome).toBe("failed");
  expect(fixture.terminated()).toBe(1);
  expect(result.evidence.kind).toBe("observed");
  expect(await readFile(join(fixture.artifactDir, "stdout.jsonl"), "utf8")).toContain(malformed);
  expect(fixture.commands).toHaveLength(1);
});

test.each([{ handoff: false }, { exitCode: 1 }, { outcomeSessionId: "other" }, { taskRefused: true }])("does not accept an unproven completion", async (options) => {
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
  Schema.decodeUnknownSync(HeadlessBenchmarkExecutionSchema, { onExcessProperty: "error" })(result);
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

test("runtime heartbeats are liveness, not candidate progress", async () => {
  const fixture = subject({ events: [
    { type: "runtime.heartbeat" },
    { type: "patch", patch: {
      cursor: { scope: "session", domain: "output", sessionId: "root" }, position: 1, prevPosition: 0,
      payload: { kind: "output.delta", delta: { blocks: [], visibleMessageCount: 1 } },
    } },
  ] });
  const activity: string[] = [];
  await executeHeadlessBenchmark({ ...fixture.input, onActivity: (kind) => activity.push(kind) });
  expect(activity).toEqual(["liveness", "progress"]);
});
