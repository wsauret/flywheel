import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { canonicalModelId } from "../../../../infra/llm/model-id.js";
import type { OwnedProcess } from "../../../../infra/owned-subprocess.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import { applyWindowsPrivateDirectoryAcl } from "../../../../infra/windows-private-directory-acl.js";
import { decodeExecutionEvidence } from "../../../../protocol/execution-evidence.js";
import { RuntimeSessionModelPlanResultSchema } from "../../../../protocol/model-assignment-protocol-schemas.js";
import type { ModelSelectionEffort, RuntimeSessionModelPlanResult } from "../../../../protocol/model-assignment-protocol-types.js";
import { RoleAssignmentViewSchema, WorkflowsModeSchema } from "../../../../protocol/runtime-protocol-schemas.js";
import { createBenchmarkAccounting } from "./accounting.js";
import { unavailableBenchmarkAccounting } from "./evidence.js";
import type { HeadlessBenchmarkExecution } from "./headless-execution-contract.js";
import { captureBenchmarkPipe as capturePipe } from "./artifact-capture.js";

interface HeadlessBenchmarkEnvironment {
  readonly [name: string]: string | undefined;
}

/** The parts of a session result this client reads (protocol/acp.ts): the
 *  configuration options and the read-only settings under `_meta`. The
 *  subject is an external process, so excess fields are ignored. */
const SessionSettingsSchema = Schema.Struct({
  configOptions: Schema.Array(Schema.Struct({ id: Schema.String, currentValue: Schema.String })),
  _meta: Schema.Struct({
    "dev.flywheel/settings": Schema.Struct({
      modelPlan: RuntimeSessionModelPlanResultSchema,
      roles: Schema.NullOr(RoleAssignmentViewSchema),
      workflowsMode: WorkflowsModeSchema,
    }),
  }),
});
const NewSessionSchema = Schema.Struct({ sessionId: Schema.String });
const InitializeSchema = Schema.Struct({ protocolVersion: Schema.Literal(1) });
const PromptResultSchema = Schema.Struct({ stopReason: Schema.String });
const PromptErrorSchema = Schema.Struct({ data: Schema.optionalKey(Schema.Struct({ failure: Schema.String })) });

const FormOptionSchema = Schema.Struct({ const: Schema.String, title: Schema.String });
/** A form elicitation that asks the subject's open question: one property per
 *  question (`q1`, `q2`, ...), whose `oneOf` or `items.anyOf` entries are the
 *  question's choice ids and labels, and optional text properties beside them. */
const QuestionFormSchema = Schema.Struct({
  sessionId: Schema.String,
  toolUseId: Schema.String,
  mode: Schema.Literal("form"),
  message: Schema.String,
  requestedSchema: Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Struct({
      type: Schema.String,
      title: Schema.String,
      description: Schema.optionalKey(Schema.String),
      oneOf: Schema.optionalKey(Schema.Array(FormOptionSchema)),
      items: Schema.optionalKey(Schema.Struct({ anyOf: Schema.Array(FormOptionSchema) })),
    })),
  }),
  // ACP v1 names the question's tool call with its own wire key.
}).pipe(Schema.encodeKeys({ toolUseId: "toolCallId" }));
type HeadlessQuestionForm = typeof QuestionFormSchema.Type;
interface HeadlessFormContent {
  readonly [property: string]: string | readonly string[];
}

const InboundSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const SessionUpdateSchema = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({
    sessionUpdate: Schema.String,
    content: Schema.optionalKey(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  }),
});

interface HeadlessBenchmarkOptions {
  readonly launcher: LauncherScope;
  readonly commandPrefix: readonly string[];
  readonly projectRoot: string;
  /** Complete caller-approved environment of every launch. Its TMPDIR, when set, holds the auth snapshot stage. */
  readonly env: HeadlessBenchmarkEnvironment;
  /** The auth profile that the subject exports as a one-use snapshot before each launch. */
  readonly profile: string;
  /** Canonical model id and effort. The public plan must report this exact pair. */
  readonly model: string;
  readonly effort: ModelSelectionEffort;
  /** A fresh private artifact directory. Existing artifact files are never overwritten. */
  readonly artifactDir: string;
  /** Applies the same caller-owned confinement to headless execution and evidence capture. */
  readonly wrapCommand?: (command: readonly string[]) => readonly string[];
  /** Capture the current normal role resolution without changing it. */
  readonly inspectRoles?: boolean;
  /** Refuse task submission unless the account's resolved Workflows mode is On. Never changes account settings. */
  readonly requireWorkflowsOn?: boolean;
  /** Canonical tools removed by the subject's public headless flag. */
  readonly disabledTools?: readonly string[];
  /** Answers a question the subject asks during the prompt: the form's
   *  accepted content, or undefined to leave the question open, which ends
   *  the run as `input_required`. Without it, every question stays open. */
  readonly answerQuestion?: (form: HeadlessQuestionForm) => HeadlessFormContent | undefined;
}

export type HeadlessBenchmarkInput = HeadlessBenchmarkOptions & (
  /** A new session, and its prompt; without a message, a preflight that submits no work. */
  | { readonly message?: string; readonly sessionId?: never; readonly answers?: never }
  /** A saved session resumed in a new process, and its prompt. `answers` names
   *  the open question that the prompt answers: the resume asks it again, and
   *  the adapter leaves that form open so that the prompt's text answers it. */
  | { readonly sessionId: string; readonly message: string; readonly answers?: string }
);

type Artifacts = HeadlessBenchmarkExecution["artifacts"];
interface CapturedArtifacts {
  [name: string]: Artifacts[string];
}

/** The parameters of a request to the subject, which encodes them as JSON. */
interface RequestParams {
  readonly [name: string]: unknown;
}

type PromptAnswer = { readonly kind: "stopped"; readonly stopReason: string } | { readonly kind: "failed"; readonly failure: string };

/** Executes one official headless subject over Agent Client Protocol v1, or
 * verifies settings without submitting work. Settings are pinned through the
 * session's configuration options and checked against its read-only settings
 * before any prompt. The prompt's answer arrives after all owned work settles.
 * Each run exports a one-use auth snapshot of the profile and gives it to the
 * subject, so the subject hosts its own runtime instead of attaching to an
 * account service, which a confined cell cannot reach. The stage that holds
 * the snapshot is removed when the run ends.
 * The caller owns the profile's login, sandbox policy, and broader disposal. Raw pipes settle
 * before evidence capture, which reads usage out of band.
 * Ownership failures throw because the parent still holds the unsettled scope. */
export async function executeHeadlessBenchmark(input: HeadlessBenchmarkInput): Promise<HeadlessBenchmarkExecution> {
  const started = performance.now();
  await mkdir(input.artifactDir, { recursive: true, mode: 0o700 });
  const scope = input.launcher.open();
  const artifacts: CapturedArtifacts = {};
  const { env } = input;
  const launch = { cwd: input.projectRoot, env };
  // Designs may name a dashed alias; the public plan always reports the canonical id.
  const model = canonicalModelId(input.model);
  const command = (args: readonly string[]) => {
    const subject = [...input.commandPrefix, ...args];
    return input.wrapCommand ? input.wrapCommand(subject) : subject;
  };
  const preflight = input.message === undefined;
  let sessionId: string | undefined = input.sessionId;
  let plan: RuntimeSessionModelPlanResult | undefined;
  let workflowsMode: HeadlessBenchmarkExecution["workflowsMode"];
  let answer: PromptAnswer | undefined;
  let prompting = false;
  let leftOpen = false;
  // The agent's message since the last update of any other kind: at the end of
  // the prompt, its final message.
  let message = "";
  let failure: string | undefined;
  let exitCode: number | null = null;
  let owned: OwnedProcess | undefined;
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    if (owned && !stopping) {
      stopping = owned.terminate().catch(() => { failure ??= "subject termination failed"; });
    }
  };
  const write = async (value: unknown) => {
    if (!owned?.stdin) throw new Error("subject has no input pipe");
    owned.stdin.write(`${JSON.stringify(value)}\n`);
    await owned.stdin.flush();
  };
  // Waits that only the subject's output settles. When that output ends, each
  // is refused, so the driver cannot outlive the subject.
  const waits = new Map<string | number, { resolve: (value: { result?: unknown; error?: unknown }) => void; reject: (error: Error) => void }>();
  let requests = 0;
  const call = async (method: string, params: RequestParams): Promise<{ result?: unknown; error?: unknown }> => {
    const id = ++requests;
    const settled = new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => { waits.set(id, { resolve, reject }); });
    await write({ jsonrpc: "2.0", id, method, params });
    return settled;
  };
  const result = async <A>(method: string, params: RequestParams, decode: (value: unknown) => A): Promise<A> => {
    const response = await call(method, params);
    if (response.error !== undefined) throw new Error(`subject refused ${method}`);
    return decode(response.result);
  };
  const reasked = Promise.withResolvers<void>();
  if (input.answers === undefined) reasked.resolve();
  const outputEnded = () => {
    for (const wait of waits.values()) wait.reject(new Error("subject output ended"));
    waits.clear();
    reasked.reject(new Error("subject output ended"));
  };
  void reasked.promise.catch(() => {});

  const ask = async (id: string | number, params: unknown) => {
    const form = Schema.decodeUnknownSync(QuestionFormSchema)(params);
    if (form.sessionId !== sessionId) throw new Error("subject asked a question of another session");
    const content = form.toolUseId === input.answers ? undefined : input.answerQuestion?.(form);
    if (content === undefined) {
      if (form.toolUseId === input.answers) reasked.resolve();
      else if (prompting) leftOpen = true;
      await write({ jsonrpc: "2.0", id, result: { action: "cancel" } });
    } else await write({ jsonrpc: "2.0", id, result: { action: "accept", content } });
  };
  const consume = async (line: string) => {
    const inbound = Schema.decodeUnknownSync(InboundSchema)(JSON.parse(line));
    if (inbound.method === undefined) {
      const wait = inbound.id === undefined ? undefined : waits.get(inbound.id);
      if (!wait || inbound.id === undefined) throw new Error("unexpected subject response correlation");
      waits.delete(inbound.id);
      wait.resolve({ result: inbound.result, error: inbound.error });
    } else if (inbound.method === "elicitation/create" && inbound.id !== undefined) {
      await ask(inbound.id, inbound.params);
    } else if (inbound.method === "session/update" && inbound.id === undefined) {
      const { sessionId: updated, update } = Schema.decodeUnknownSync(SessionUpdateSchema)(inbound.params);
      if (updated !== sessionId || !prompting) return;
      if (update.sessionUpdate === "agent_message_chunk") message += update.content?.text ?? "";
      else if (update.sessionUpdate !== "usage_update" && update.sessionUpdate !== "config_option_update") message = "";
    } else {
      throw new Error("unexpected subject request");
    }
  };

  /** Opens or resumes the session, pins and checks its settings, and runs the prompt. */
  const drive = async () => {
    await result("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }, Schema.decodeUnknownSync(InitializeSchema));
    const cwd = input.projectRoot;
    let settings: typeof SessionSettingsSchema.Type;
    if (input.sessionId === undefined) {
      settings = await result("session/new", { cwd, mcpServers: [] }, (opened) => {
        // The session exists once the subject names it, so its evidence is read even when its settings are refused.
        sessionId = Schema.decodeUnknownSync(NewSessionSchema)(opened).sessionId;
        return Schema.decodeUnknownSync(SessionSettingsSchema)(opened);
      });
    } else {
      settings = await result("session/resume", { sessionId, cwd }, Schema.decodeUnknownSync(SessionSettingsSchema));
    }
    for (const [configId, value] of [["model", model], ["effort", input.effort]] as const) {
      // The chat seat of a session lives in its role assignments, not in the
      // profile config, so each change saves for this session only.
      settings = await result("session/set_config_option", { sessionId, configId, value }, Schema.decodeUnknownSync(SessionSettingsSchema));
      if (settings.configOptions.find((option) => option.id === configId)?.currentValue !== value) {
        throw new Error(`subject did not select the requested ${configId}`);
      }
    }
    const observed = settings._meta["dev.flywheel/settings"];
    plan = observed.modelPlan;
    artifacts.plan = await writeArtifact(join(input.artifactDir, "plan.json"), JSON.stringify(plan));
    const assignment = plan.assignments.find((row) => row.slot.kind === "role" && row.slot.roleId === "chat");
    const route = plan.plans.find((row) => row.model === model);
    if (plan.sessionId !== sessionId || plan.profile.effectiveId !== input.profile ||
        assignment?.model !== model || assignment.effort !== input.effort ||
        route?.kind !== "available" || route.candidates.length === 0) {
      throw new Error("subject public model plan refused the requested profile, model, effort, or route");
    }
    if (input.inspectRoles) {
      if (!observed.roles) throw new Error("subject role evidence unavailable");
      const normalRoles = Object.fromEntries(Object.entries(observed.roles.assignments).filter(([id]) => id !== "chat"));
      artifacts.roles = await writeArtifact(join(input.artifactDir, "roles.json"), JSON.stringify(normalRoles));
    }
    if (input.requireWorkflowsOn) {
      workflowsMode = observed.workflowsMode;
      artifacts.modules = await writeArtifact(join(input.artifactDir, "modules.json"), JSON.stringify({ workflowsMode }));
      if (workflowsMode !== "on") {
        failure = `Workflows must be On before a benchmark cell starts (observed ${workflowsMode}); set Workflows On in the account settings`;
        throw new Error(failure);
      }
    }
    if (!preflight) {
      // A prompt sent while the resumed question's form is open is refused.
      await reasked.promise;
      prompting = true;
      const response = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: input.message }] });
      prompting = false;
      if (response.error === undefined) answer = { kind: "stopped", ...Schema.decodeUnknownSync(PromptResultSchema)(response.result) };
      else {
        const reported = Schema.decodeUnknownOption(PromptErrorSchema)(response.error);
        answer = { kind: "failed", failure: reported._tag === "Some" && reported.value.data ? reported.value.data.failure : "unreported" };
      }
    }
    owned?.stdin?.end();
  };

  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const protocolFailed = () => {
    // Parser errors can contain subject output. Raw bytes remain in private artifacts.
    failure ??= "subject ACP protocol or settings validation failed";
    stop();
  };
  const parseChunk = async (chunk: Uint8Array) => {
    if (failure) return;
    try {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) await consume(line);
        if (failure) break;
      }
    } catch { protocolFailed(); }
  };
  let evidence: HeadlessBenchmarkExecution["evidence"] = { kind: "unavailable", reason: "subject supplied no session id" };
  let total = createBenchmarkAccounting().observe();
  let parent = createBenchmarkAccounting().observe();
  let closure: Awaited<ReturnType<LauncherScope["close"]>>;
  let executionFailure: { cause: unknown } | undefined;
  let stage: string | undefined;
  try {
    try {
      // The stage is in the cell's own temporary folder, which its confinement lets both commands write and read.
      stage = await mkdtemp(join(env.TMPDIR ?? tmpdir(), "flywheel-auth-bundle-"));
      applyWindowsPrivateDirectoryAcl(stage);
      const snapshot = join(stage, "auth.json");
      const exported = await runCaptured(scope, command(["headless", "snapshot-auth", "--auth-profile", input.profile, "--output", snapshot]), launch, artifacts,
        [["authSnapshot", join(input.artifactDir, "auth-snapshot.txt")], ["authSnapshotStderr", join(input.artifactDir, "auth-snapshot-stderr.txt")]]);
      if (!exported) {
        failure = "subject auth snapshot export failed";
        throw new Error(failure);
      }
      owned = await scope.spawnOwned(command(["--headless", "--acp", "--auth-snapshot", snapshot, ...(input.disabledTools ?? []).flatMap(name => ["--disable-tool", name]), "--project-root", input.projectRoot]), launch);
      const driving = drive().catch(() => { failure ??= "subject ACP protocol or settings validation failed"; stop(); });
      const pipes = await Promise.allSettled([
        capturePipe(owned.stdout, join(input.artifactDir, "stdout.jsonl"), parseChunk, stop),
        capturePipe(owned.stderr, join(input.artifactDir, "stderr.txt"), undefined, stop),
      ]);
      for (const [index, captured] of pipes.entries()) {
        if (captured.status === "fulfilled") artifacts[index === 0 ? "stdout" : "stderr"] = captured.value;
        else failure ??= "subject pipe capture failed";
      }
      if (!failure) {
        try {
          pending += decoder.decode();
          if (pending.trim()) await consume(pending);
        } catch { protocolFailed(); }
      }
      outputEnded();
      await driving;
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
        const read = await runCaptured(scope, command(["events", "evidence", "--session", sessionId, "--project-root", input.projectRoot]), launch, artifacts,
          [["evidence", join(input.artifactDir, "evidence.json")], ["evidenceStderr", join(input.artifactDir, "evidence-stderr.txt")]]);
        if (!read) throw new Error("subject evidence command did not settle successfully");
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
    // The subject consumes the snapshot when it starts; a run that ended before that leaves it here.
    if (stage) await rm(stage, { recursive: true, force: true });
  }
  if (!closure.settled) throw new Error(`benchmark execution ownership unsettled: ${closure.reason}`, { cause: executionFailure?.cause });
  if (executionFailure) throw executionFailure.cause;
  const handoff = message.trim() ? { summary: message } : undefined;
  let outcome: HeadlessBenchmarkExecution["outcome"] = "failed";
  if (!failure && answer?.kind === "failed") failure = `subject turn failed (${answer.failure})`;
  else if (!failure && answer?.kind === "stopped") {
    const settled = answer.stopReason === "end_turn" ? leftOpen ? "input_required" : handoff ? "complete" : "incomplete"
      : answer.stopReason === "cancelled" ? "incomplete" : "failed";
    // Headless chat exits 0 when its work drained and 2 when a question is open.
    if (settled === "failed") failure = `subject stopped the turn (${answer.stopReason})`;
    else if (settled === "incomplete" || exitCode === (settled === "complete" ? 0 : 2)) outcome = settled;
    else failure = "subject exit code disagrees with its prompt answer";
  } else if (!failure && preflight && sessionId && exitCode === 0) outcome = "preflight";
  return {
    version: 1, outcome, exitCode, wallMs: performance.now() - started,
    ...(sessionId ? { sessionId } : {}),
    ...(plan ? { plan } : {}),
    ...(workflowsMode ? { workflowsMode } : {}),
    ...(outcome === "complete" && handoff ? { handoff } : {}),
    ...(failure ? { reason: failure } : {}),
    evidence, totalAccounting: total, parentAccounting: parent, artifacts,
  };
}

/** Runs one finite subject command with no input and records its stdout and
 *  stderr under the named artifacts. Resolves whether it exited 0 and
 *  surrendered ownership with both pipes captured. */
async function runCaptured(scope: LauncherScope, command: readonly string[], launch: Parameters<LauncherScope["spawnOwned"]>[1], artifacts: CapturedArtifacts,
  outputs: readonly [stdout: readonly [name: string, path: string], stderr: readonly [name: string, path: string]]): Promise<boolean> {
  const child = await scope.spawnOwned(command, launch);
  child.stdin?.end();
  const end = () => { void child.terminate().catch(() => {}); };
  const pipes = await Promise.allSettled([capturePipe(child.stdout, outputs[0][1], undefined, end), capturePipe(child.stderr, outputs[1][1], undefined, end)]);
  for (const [index, captured] of pipes.entries()) {
    if (captured.status === "fulfilled") artifacts[outputs[index]![0]] = captured.value;
  }
  const exit = await child.exited;
  return exit.code === 0 && exit.ownership === "surrendered" && pipes.every((pipe) => pipe.status === "fulfilled");
}

async function writeArtifact(path: string, value: string): Promise<Artifacts[string]> {
  const bytes = new TextEncoder().encode(value);
  return capturePipe(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), path);
}
