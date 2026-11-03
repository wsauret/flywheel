import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { canonicalModelId } from "../../../../infra/llm/model-id.js";
import type { OwnedProcess } from "../../../../infra/owned-subprocess.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import type { FrontendMutation } from "../../../../protocol/app-service-types.js";
import type { RuntimeRoleSnapshotResult } from "../../../../protocol/role-protocol-types.js";
import type { RuntimeModuleSnapshotResult } from "../../../../protocol/module-protocol-types.js";
import type { RuntimeUiPatch } from "../../../../protocol/runtime-ui-protocol-types.js";
import { decodeExecutionEvidence } from "../../../../protocol/execution-evidence.js";
import { HeadlessChatRecordSchema, HeadlessChatRequestSchema, type HeadlessChatRecord } from "../../../../protocol/headless-chat.js";
import { RuntimeSaveModelEffortResultSchema, RuntimeSessionModelPlanResultSchema } from "../../../../protocol/model-assignment-protocol-schemas.js";
import type { ModelSelectionEffort, RuntimeSessionModelPlanResult } from "../../../../protocol/model-assignment-protocol-types.js";
import { runtimeDispatchResultSchema } from "../../../../protocol/runtime-dispatch-result-schemas.js";
import { runtimeQueryResultSchema } from "../../../../protocol/runtime-protocol-schemas.js";
import { createBenchmarkAccounting } from "./accounting.js";
import { unavailableBenchmarkAccounting } from "./evidence.js";
import type { HeadlessBenchmarkExecution } from "./headless-execution-contract.js";
import { captureBenchmarkPipe as capturePipe } from "./artifact-capture.js";

interface HeadlessBenchmarkEnvironment {
  readonly [name: string]: string | undefined;
}

// SAFETY: the registry entry for "roleSnapshot" is RuntimeRoleSnapshotResultSchema, so decoding through it yields exactly this type.
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the public registry validates this query but erases its result type
const roleSnapshotSchema = runtimeQueryResultSchema("roleSnapshot") as Schema.Codec<RuntimeRoleSnapshotResult>;
// SAFETY: moduleSnapshot's registered schema validates the complete module descriptor before this adapter reads its mode.
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the query registry erases the concrete result type
const moduleSnapshotSchema = runtimeQueryResultSchema("moduleSnapshot") as Schema.Codec<RuntimeModuleSnapshotResult>;

interface HeadlessBenchmarkOptions {
  readonly launcher: LauncherScope;
  readonly commandPrefix: readonly string[];
  readonly projectRoot: string;
  /** Complete caller-approved environment. The adapter adds only the public profile selector. */
  readonly env: HeadlessBenchmarkEnvironment;
  readonly profile: string;
  /** Canonical model id and effort. The public plan must report this exact pair. */
  readonly model: string;
  readonly effort: ModelSelectionEffort;
  /** A fresh private artifact directory. Existing artifact files are never overwritten. */
  readonly artifactDir: string;
  readonly sessionId?: string;
  /** Applies the same caller-owned confinement to headless execution and evidence capture. */
  readonly wrapCommand?: (command: readonly string[]) => readonly string[];
  /** Heartbeats indicate liveness only. Output deltas indicate candidate progress. */
  readonly onActivity?: (kind: "liveness" | "progress") => void;
  /** Capture the current normal role resolution without changing it. */
  readonly inspectRoles?: boolean;
  /** Refuse task submission unless the account's resolved Workflows mode is On. Never changes account settings. */
  readonly requireWorkflowsOn?: boolean;
  /** Canonical tools removed by the subject's public headless flag. */
  readonly disabledTools?: readonly string[];
}

export type HeadlessBenchmarkInput = HeadlessBenchmarkOptions & (
  | { readonly message?: string; readonly questionAnswer?: never }
  | { readonly questionAnswer: Extract<FrontendMutation, { type: "question.answer" }>; readonly sessionId: string; readonly message?: never }
);

type Artifacts = HeadlessBenchmarkExecution["artifacts"];
interface CapturedArtifacts {
  [name: string]: Artifacts[string];
}

/** Executes one official headless subject, or verifies settings without submitting work.
 * The caller owns auth, sandbox policy, and broader disposal. No question is answered.
 * Raw pipes settle before evidence capture.
 * Ownership failures throw because the parent still holds the unsettled scope. */
export async function executeHeadlessBenchmark(input: HeadlessBenchmarkInput): Promise<HeadlessBenchmarkExecution> {
  const started = performance.now();
  await mkdir(input.artifactDir, { recursive: true, mode: 0o700 });
  const scope = input.launcher.open();
  const artifacts: CapturedArtifacts = {};
  const env = { ...input.env, FLYWHEEL_AUTH_PROFILE: input.profile };
  // Designs may name a dashed alias; the public plan always reports the canonical id.
  const model = canonicalModelId(input.model);
  const command = (args: readonly string[]) => {
    const subject = [...input.commandPrefix, ...args];
    return input.wrapCommand ? input.wrapCommand(subject) : subject;
  };
  let sessionId: string | undefined = input.sessionId;
  let plan: RuntimeSessionModelPlanResult | undefined;
  let finalRecord: Extract<HeadlessChatRecord, { type: "outcome" }> | undefined;
  let workflowsMode: HeadlessBenchmarkExecution["workflowsMode"];
  let stage: "ready" | "settings" | "plan" | "roles" | "modules" | "task" | "outcome" = "ready";
  const observePatch = (patch: RuntimeUiPatch) => {
    if (patch.payload.kind === "output.delta") input.onActivity?.("progress");
  };
  let failure: string | undefined;
  let exitCode: number | null = null;
  let owned: OwnedProcess | undefined;
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    if (owned && !stopping) {
      stopping = owned.terminate().catch(() => { failure ??= "subject termination failed"; });
    }
  };
  const send = async (record: unknown) => {
    const validated = Schema.decodeUnknownSync(HeadlessChatRequestSchema, { onExcessProperty: "error" })(record);
    if (!owned?.stdin) throw new Error("subject has no JSONL input pipe");
    owned.stdin.write(`${JSON.stringify(validated)}\n`);
    await owned.stdin.flush();
  };
  const preflight = input.message === undefined && input.questionAnswer === undefined;
  const submit = async () => {
    stage = "task";
    if (preflight) owned?.stdin?.end();
    else {
      if (input.questionAnswer && input.questionAnswer.sessionId !== sessionId) throw new Error("question answer session does not match the subject");
      await send({ version: 1, type: "dispatch", id: "task", command: input.questionAnswer ?? { type: "session.send", sessionId, input: input.message } });
    }
  };
  const checkModules = async () => {
    if (!input.requireWorkflowsOn) return submit();
    stage = "modules";
    await send({ version: 1, type: "query", id: "modules", query: { type: "moduleSnapshot" } });
  };
  const consume = async (record: HeadlessChatRecord) => {
    if (finalRecord) throw new Error("subject emitted records after outcome");
    switch (record.type) {
      case "ready":
        if (stage !== "ready" || !record.sessionId ||
            input.sessionId !== undefined && input.sessionId !== record.sessionId) throw new Error("unexpected subject ready record");
        sessionId = record.sessionId;
        stage = "settings";
        await send({ version: 1, type: "dispatch", id: "settings", command: {
          type: "model.save_effort", scope: { kind: "session", sessionId },
          slot: { kind: "role", roleId: "chat" }, model, effort: input.effort,
        } });
        break;
      case "result":
        if (record.id === "settings" && stage === "settings") {
          Schema.decodeUnknownSync(RuntimeSaveModelEffortResultSchema)(record.result);
          stage = "plan";
          await send({ version: 1, type: "query", id: "plan", query: {
            type: "sessionModelPlan", sessionId, slots: [{ kind: "role", roleId: "chat" }],
          } });
        } else if (record.id === "plan" && stage === "plan") {
          plan = Schema.decodeUnknownSync(RuntimeSessionModelPlanResultSchema, { onExcessProperty: "error" })(record.result);
          artifacts.plan = await writeArtifact(join(input.artifactDir, "plan.json"), JSON.stringify(plan));
          const assignment = plan.assignments.find((row) => row.slot.kind === "role" && row.slot.roleId === "chat");
          const route = plan.plans.find((row) => row.model === model);
          if (plan.sessionId !== sessionId || plan.profile.effectiveId !== input.profile ||
              assignment?.model !== model || assignment.effort !== input.effort ||
              route?.kind !== "available" || route.candidates.length === 0) {
            throw new Error("subject public model plan refused the requested profile, model, effort, or route");
          }
          if (input.inspectRoles) {
            stage = "roles";
            await send({ version: 1, type: "query", id: "roles", query: { type: "roleSnapshot", sessionIds: [sessionId] } });
          } else await checkModules();
        } else if (record.id === "roles" && stage === "roles") {
          const snapshot = Schema.decodeUnknownSync(roleSnapshotSchema, { onExcessProperty: "error" })(record.result);
          const roles = snapshot.views.find((row) => row.sessionId === sessionId)?.view;
          if (!roles) throw new Error("subject role evidence unavailable");
          const normalRoles = Object.fromEntries(Object.entries(roles.assignments).filter(([id]) => id !== "chat"));
          artifacts.roles = await writeArtifact(join(input.artifactDir, "roles.json"), JSON.stringify(normalRoles));
          await checkModules();
        } else if (record.id === "modules" && stage === "modules") {
          const snapshot = Schema.decodeUnknownSync(moduleSnapshotSchema)(record.result);
          workflowsMode = snapshot.capabilities.workflowsMode;
          artifacts.modules = await writeArtifact(join(input.artifactDir, "modules.json"), JSON.stringify(snapshot));
          if (workflowsMode !== "on" || snapshot.capabilities.error) {
            failure = `Workflows must be On before a benchmark cell starts (observed ${workflowsMode}); set Workflows On in the account settings`;
            throw new Error(failure);
          }
          await submit();
        } else if (record.id === "task" && stage === "task") {
          const result = Schema.decodeUnknownSync(runtimeDispatchResultSchema(input.questionAnswer ? "question.answer" : "session.send"))(record.result);
          if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) throw new Error("subject refused the task submission");
        } else {
          throw new Error("unexpected subject result correlation");
        }
        break;
      case "error":
        throw new Error(`subject JSONL command refused (${record.id ?? "unidentified"})`);
      case "event":
        if (record.event.type === "runtime.heartbeat") input.onActivity?.("liveness");
        else if (record.event.type === "patch") observePatch(record.event.patch);
        break;
      case "outcome":
        if (stage !== "task" || record.sessionId !== sessionId) throw new Error("subject outcome lacks a verified matching session");
        finalRecord = record;
        stage = "outcome";
        break;
    }
  };
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parseChunk = async (chunk: Uint8Array) => {
    if (failure) return;
    try {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) await consume(Schema.decodeUnknownSync(HeadlessChatRecordSchema, { onExcessProperty: "error" })(JSON.parse(line)));
        if (failure) break;
      }
    } catch {
      // Parser errors can contain subject output. Raw bytes remain in private artifacts.
      failure ??= "subject JSONL protocol or settings validation failed";
      stop();
    }
  };
  let evidence: HeadlessBenchmarkExecution["evidence"] = { kind: "unavailable", reason: "subject supplied no session id" };
  let total = createBenchmarkAccounting().observe();
  let parent = createBenchmarkAccounting().observe();
  let closure: Awaited<ReturnType<LauncherScope["close"]>>;
  let executionFailure: { cause: unknown } | undefined;
  try {
    try {
      // One-shot reports EOF without submitted work as incomplete, so preflight runs persistent and settles complete.
      owned = await scope.spawnOwned(command(["--headless", ...(preflight ? [] : ["--one-shot"]), ...(input.disabledTools ?? []).flatMap(name => ["--disable-tool", name]), ...(input.sessionId ? ["--session", input.sessionId] : []), "--project-root", input.projectRoot]), { cwd: input.projectRoot, env });
      const pipes = await Promise.allSettled([
        capturePipe(owned.stdout, join(input.artifactDir, "stdout.jsonl"), parseChunk, stop),
        capturePipe(owned.stderr, join(input.artifactDir, "stderr.txt"), undefined, stop),
      ]);
      for (const [index, result] of pipes.entries()) {
        if (result.status === "fulfilled") artifacts[index === 0 ? "stdout" : "stderr"] = result.value;
        else failure ??= "subject pipe capture failed";
      }
      if (!failure) {
        try {
          pending += decoder.decode();
          if (pending.trim()) await consume(Schema.decodeUnknownSync(HeadlessChatRecordSchema, { onExcessProperty: "error" })(JSON.parse(pending)));
        } catch { failure = "subject JSONL final record validation failed"; stop(); }
      }
      const exit = await owned.exited;
      exitCode = exit.code;
      if (exit.ownership !== "surrendered") failure ??= "subject ownership not surrendered";
      await stopping;
    } catch {
      failure ??= "subject launch or settlement failed";
      stop();
      await stopping;
    }
    if (sessionId) {
      evidence = { kind: "unavailable", reason: "subject evidence capture failed" };
      try {
        const reader = await scope.spawnOwned(command(["events", "evidence", "--session", sessionId, "--project-root", input.projectRoot]), { cwd: input.projectRoot, env });
        reader.stdin?.end();
        const endReader = () => { void reader.terminate().catch(() => {}); };
        const pipes = await Promise.allSettled([
          capturePipe(reader.stdout, join(input.artifactDir, "evidence.json"), undefined, endReader),
          capturePipe(reader.stderr, join(input.artifactDir, "evidence-stderr.txt"), undefined, endReader),
        ]);
        for (const [index, result] of pipes.entries()) {
          if (result.status === "fulfilled") artifacts[index === 0 ? "evidence" : "evidenceStderr"] = result.value;
        }
        const exit = await reader.exited;
        if (exit.code !== 0 || exit.ownership !== "surrendered" || pipes.some((pipe) => pipe.status === "rejected")) {
          throw new Error("subject evidence command did not settle successfully");
        }
        const value = decodeExecutionEvidence(JSON.parse(await readFile(join(input.artifactDir, "evidence.json"), "utf8")));
        const root = value.sessions.find((session) => session.sessionId === sessionId);
        if (value.rootSessionId !== sessionId || value.projectRoot !== input.projectRoot || !root) throw new Error("subject evidence identity does not match");
        const observedTotal = createBenchmarkAccounting();
        const observedParent = createBenchmarkAccounting();
        for (const session of value.sessions) {
          for (const entry of session.usageEntries) {
            observedTotal.commit(entry);
            if (session.sessionId === sessionId) observedParent.commit(entry);
          }
        }
        parent = observedParent.observe();
        const discoveryIncomplete = value.descendantDiscovery === "incomplete";
        const reason = "subject descendant discovery is incomplete";
        total = discoveryIncomplete ? unavailableBenchmarkAccounting(reason) : observedTotal.observe();
        evidence = discoveryIncomplete ? { kind: "unavailable", reason } : {
          kind: "observed", value,
          requestCount: value.sessions.reduce((count, session) => count + session.requests.length, 0),
          parentRequestCount: root.requests.length,
          childSessionCount: value.sessions.filter((session) => session.sessionId !== sessionId).length,
        };
      } catch {
        evidence = { kind: "unavailable", reason: "subject evidence command, identity, or canonical usage validation failed" };
      }
    }
  } catch (cause) {
    executionFailure = { cause };
  } finally {
    closure = await scope.close();
  }
  if (!closure.settled) throw new Error(`benchmark execution ownership unsettled: ${closure.reason}`, { cause: executionFailure?.cause });
  if (executionFailure) throw executionFailure.cause;
  let outcome: HeadlessBenchmarkExecution["outcome"] = "failed";
  // The headless contract exits 0 for complete, 1 for failed, and 2 for input_required or incomplete.
  if (!failure && finalRecord && exitCode === (finalRecord.outcome === "complete" ? 0 : finalRecord.outcome === "failed" ? 1 : 2)) {
    outcome = finalRecord.outcome;
    if (outcome === "complete") {
      outcome = preflight ? "preflight" : finalRecord.handoff ? "complete" : "incomplete";
    }
  }
  return {
    version: 1, outcome, exitCode, wallMs: performance.now() - started,
    ...(sessionId ? { sessionId } : {}),
    ...(plan ? { plan } : {}),
    ...(workflowsMode ? { workflowsMode } : {}),
    ...(outcome === "complete" && finalRecord?.handoff ? { handoff: finalRecord.handoff } : {}),
    ...(failure ? { reason: failure } : {}),
    evidence, totalAccounting: total, parentAccounting: parent, artifacts,
  };
}

async function writeArtifact(path: string, value: string): Promise<Artifacts[string]> {
  const bytes = new TextEncoder().encode(value);
  return capturePipe(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), path);
}

