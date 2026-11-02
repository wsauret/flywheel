import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { interruptedLabel } from "../../../../infra/output/run-labels.js";
import { createPersistentProcessManager } from "../../../../infra/persistent-process-manager.js";
import { isProcessAlive } from "../../../../infra/process-liveness.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import { isWorkingStatus, type StatusView } from "../../../../protocol/status-protocol-types.js";
import type { FrontendOutputBlock } from "../../../../protocol/app-service-types.js";
import { createRuntimeChatKernel } from "../../../app-service/runtime-chat-kernel.js";
import { assembleProjectRuntime, type RuntimeCompositionOptions } from "../../../app-service/project-execution-runtime.js";
import { quickTitleFromMessage } from "../../../session/session-title.js";
import type { ScenarioName } from "../cli/claude-sdk.js";
import { setupClaudeSdkHome, type ClaudeSdkProfileOptions } from "./setup.js";

/** How long one scenario may run before it reports itself incomplete. */
const SCENARIO_BUDGET_MS = 10 * 60_000;
const POLL_MS = 50;
/** The sessions count as settled after all of them stay at rest this long. */
const REST_MS = 400;
/**
 * How long a runtime scenario waits for the generated title after its last turn started. The title request runs
 * beside the chat turn on its own query, and on a live login it can answer after a short turn ends. The title
 * runner's own watchdog is 90 s per turn.
 */
const TITLE_WAIT_MS = 120_000;

/** The words each scenario sends. A live login answers them; a fake host scripts its answers instead. */
const PROMPTS = {
  chat: "List the files in this directory with the list tool, then read README.md with the read tool and reply with its first line.",
  child: "Use the subagent tool to ask an explorer to read README.md and report its first line, then reply with that line.",
  title: "Say hello in one short sentence.",
  workflow: "Use the workflow tool to launch claude-sdk-greeting.workflow.yaml by path. Its agent will check README.md and fix the greeting only if it is broken. Wait for its result and report it.",
  // Flywheel's bash refuses a sleep longer than 30 s. The stop arrives within a second of the call's start.
  stop: "Run the shell command `sleep 25` with the bash tool in the foreground, then reply with the word done.",
  stopFollowUp: "Reply with the single word ready.",
} as const;

/** An isolated project and Flywheel home, and the config directories of the Claude accounts its profile has. */
interface ScenarioPlace {
  readonly root: string;
  readonly projectRoot: string;
  readonly accountHome: string;
  readonly userDataRoot: string;
  readonly configDirs: readonly string[];
}

/** What a scenario observed, with ids, counts, and kinds only. */
export interface ScenarioReport {
  readonly scenario: ScenarioName;
  readonly completed: boolean;
  readonly sessionId?: string;
  readonly durationMs: number;
  readonly blocks?: { readonly [kind: string]: number };
  /** The runtime scenarios only: whether a generated title replaced the quick title before the runtime closed. */
  readonly titleGenerated?: boolean;
  /** The stop scenario only. */
  readonly stop?: StopObservation;
  /** What the run left in the config directories of the profile's Claude accounts after the runtime closed. */
  readonly cleanup?: ScenarioCleanup;
  readonly errors?: readonly string[];
  readonly failure?: string;
}

/** How a person's stop of a running tool ended, and whether the session took the next message. */
interface StopObservation {
  /** The transcript shows the turn end that a person's interrupt records. */
  readonly interrupted: boolean;
  /** The status of the bash call that the stop cut. */
  readonly toolStatus: string | undefined;
  /** The follow-up message got a reply. */
  readonly followUpReplied: boolean;
}

interface ScenarioCleanup {
  /** Claude CLI processes that still run on a config directory: each records `sessions/<pid>.json` while it runs. */
  readonly cliProcesses: number;
  /** Whether a CLI project directory of the scenario's project remains: it would hold a rotation transcript. */
  readonly projectDirectory: boolean;
}

/** The catalog row that shows a scenario's title, and the quick title that it shows until the generated title lands. */
interface TitleRow {
  readonly sessionId: string;
  readonly quickTitle: string;
}

/** One session's status, as the runtime shows it. */
interface SessionStatus {
  readonly sessionId: string;
  readonly view: StatusView | undefined;
}

/** What a scenario runs on: the provider's accounts, and the account home whose `claude-sdk` profile holds the login.
 *  Without a home, the scenario prepares a new one in its temporary root, whose profile has no login. */
type ScenarioOptions = Pick<ClaudeSdkProfileOptions, "accounts"> & { readonly accountHome?: string; readonly model?: string };

/** Creates an isolated project with one README, and sets up the account home for the provider. The profile serves
 *  only a login of its own, which `flywheel claude-sdk setup --home <dir> --login` adds. */
async function prepareScenarioPlace(options: ScenarioOptions): Promise<ScenarioPlace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flywheel-claude-sdk-scenario-")));
  const accountHome = options.accountHome ?? join(root, "home");
  const place = { root, projectRoot: join(root, "project"), accountHome, userDataRoot: join(accountHome, ".flywheel") };
  mkdirSync(place.projectRoot, { recursive: true });
  writeFileSync(join(place.projectRoot, "README.md"), "Hello from the scenario project.\n");
  writeFileSync(join(place.projectRoot, "claude-sdk-greeting.workflow.yaml"), `id: claude-sdk-greeting
name: Check the greeting
description: Check the scenario project's greeting and fix it only if it is broken.
phases:
  - phase: check
    brief: Read README.md and check whether its greeting is broken. Fix it only if it is broken. Verify the result and report what you found.
`);
  const { accounts } = await setupClaudeSdkHome({ userDataRoot: place.userDataRoot, accounts: options.accounts, ...(options.model === undefined ? {} : { model: options.model }) });
  return { ...place, configDirs: accounts.map(({ configDir }) => configDir) };
}

/** The production runtime composition of a place, over the in-process chat kernel, as a client reaches it. */
interface ScenarioRuntime {
  openChat(workflows?: boolean): Promise<string>;
  /** Finds the workflow that the chat launched, or returns undefined when it launched none. */
  workflowSession(parentSessionId: string): Promise<string | undefined>;
  send(sessionId: string, input: string): Promise<void>;
  /** Stops the session's running turn, as a person's Escape does. */
  interrupt(sessionId: string): Promise<void>;
  /** The status of every session the runtime holds: each catalog row and each session this runtime opened or launched. */
  statuses(): Promise<readonly SessionStatus[]>;
  /** The title the session's catalog row shows, or undefined when the catalog has no such row. */
  title(sessionId: string): Promise<string | undefined>;
  blocks(sessionId: string): Promise<readonly FrontendOutputBlock[]>;
  dispose(): Promise<void>;
}

/** Seams for tests only: the runtime a place opens, and the pacing of the waits. */
interface ScenarioSeams {
  readonly openRuntime?: (place: ScenarioPlace, launcher: LauncherScope) => Promise<ScenarioRuntime>;
  readonly pollMs?: number;
  readonly restMs?: number;
  readonly titleWaitMs?: number;
}

async function openScenarioRuntime(place: ScenarioPlace, launcher: LauncherScope): Promise<ScenarioRuntime> {
  const processes = createPersistentProcessManager();
  const options: RuntimeCompositionOptions = {
    projectRoot: place.projectRoot, executionCwd: place.projectRoot, accountHome: place.accountHome, userDataRoot: place.userDataRoot,
    // Only a source run installs this module, so the source Worker entry is always present.
    workerUrl: new URL("../../../app-service/worker-entry.ts", import.meta.url).href,
    launcher, persistentProcesses: processes.client(), allowPersistentProcesses: false,
  };
  const composition = await assembleProjectRuntime(options, (scope, lane) => createRuntimeChatKernel(options, scope, lane));
  const client = composition.client;
  const started = new Set<string>();
  return {
    async openChat(workflows) {
      if (workflows) {
        const snapshot = await client.query({ type: "moduleSnapshot" });
        const enabled = await client.dispatch({ type: "settings.set_workflow_mode", expected: snapshot.capabilities.workflowsMode, mode: "on" });
        if (!enabled.ok) throw new Error("The runtime refused to enable workflows");
      }
      const opened = await client.dispatch({ type: "chat.open" });
      if (!opened.ok || opened.sessionId === undefined) throw new Error("The runtime refused to open a chat");
      started.add(opened.sessionId);
      return opened.sessionId;
    },
    async workflowSession(parentSessionId) {
      const work = await client.query({ type: "sessionBackgroundWork", sessionId: parentSessionId });
      return work.rows.flatMap(({ target }) => target?.kind === "workflow" ? [target.workflowId] : [])[0];
    },
    async send(sessionId, input) {
      const sent = await client.dispatch({ type: "session.send", sessionId, input });
      if (!sent.ok) throw new Error(`The runtime refused the message: ${JSON.stringify(sent)}`);
    },
    async interrupt(sessionId) {
      const interrupted = await client.dispatch({ type: "chat.interrupt", sessionId });
      if (!interrupted.ok) throw new Error(`The runtime refused the interrupt: ${JSON.stringify(interrupted)}`);
    },
    async statuses() {
      // A child has no catalog row; its parent's status counts its active work.
      const rows = (await client.query({ type: "snapshot" })).rows.map((row) => row.id);
      const sessionIds = [...new Set([...rows, ...started])];
      return (await client.query({ type: "statusSnapshot", sessionIds })).views.map((entry) => ({ sessionId: entry.sessionId, view: entry.view ?? undefined }));
    },
    async title(sessionId) {
      return (await client.query({ type: "snapshot" })).rows.find((row) => row.id === sessionId)?.title;
    },
    async blocks(sessionId) {
      const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 512, maxBytes: 4_000_000 } } });
      return window.range.kind === "ok" ? window.range.blocks : [];
    },
    async dispose() {
      await composition.dispose({ clientsHold: false });
      await composition.releaseState();
      processes.releaseAll();
    },
  };
}

/** Counts a transcript's blocks by kind and collects its error notices. */
function summarizeBlocks(blocks: readonly FrontendOutputBlock[]): Pick<ScenarioReport, "blocks" | "errors"> {
  const counts: { [kind: string]: number } = {};
  for (const block of blocks) counts[block.kind] = (counts[block.kind] ?? 0) + 1;
  return { blocks: counts, errors: blocks.flatMap((block) => block.kind === "system" && block.level === "error" ? [block.message] : []) };
}

/**
 * Waits until every session the runtime holds stayed at rest for the rest time after `sessionId` was at work, so
 * that closing the runtime aborts no work: a workflow's parent chat starts its follow-up turn only after the
 * workflow rests. `seenWork` says that the session was already at work before the wait. With `title`, the wait
 * also holds until that row shows another title or the title wait ran out, because the title request runs on its
 * own query beside the turn. Returns whether a generated title arrived.
 */
async function settleSessions(
  runtime: ScenarioRuntime, sessionId: string, seams: ScenarioSeams, options: { readonly seenWork?: boolean; readonly title?: TitleRow } = {},
): Promise<{ readonly titleGenerated?: boolean }> {
  const startedAt = Date.now();
  let worked = options.seenWork === true;
  let restSince: number | undefined;
  let titleGenerated = false;
  for (;;) {
    const statuses = await runtime.statuses();
    const now = Date.now();
    if (statuses.some((entry) => entry.sessionId === sessionId && isWorkingStatus(entry.view))) worked = true;
    if (statuses.some((entry) => isWorkingStatus(entry.view))) restSince = undefined;
    else if (worked) restSince ??= now;
    if (options.title !== undefined && !titleGenerated) {
      const title = await runtime.title(options.title.sessionId);
      titleGenerated = title !== undefined && title !== options.title.quickTitle;
    }
    const rested = restSince !== undefined && now - restSince >= (seams.restMs ?? REST_MS);
    const titleSettled = options.title === undefined || titleGenerated || now - startedAt >= (seams.titleWaitMs ?? TITLE_WAIT_MS);
    if (rested && titleSettled) return options.title === undefined ? {} : { titleGenerated };
    if (now - startedAt >= SCENARIO_BUDGET_MS) {
      const working = statuses.filter((entry) => isWorkingStatus(entry.view)).map((entry) => `${entry.sessionId} ${entry.view?.activity ?? "none"}`);
      throw new Error(`The sessions did not settle within ${SCENARIO_BUDGET_MS} ms; still working: ${working.join(", ") || "none"}`);
    }
    await Bun.sleep(seams.pollMs ?? POLL_MS);
  }
}

/** Waits until `sessionId` runs a foreground bash call, and fails when its turn ends without one. */
async function bashRunning(runtime: ScenarioRuntime, sessionId: string, seams: ScenarioSeams): Promise<void> {
  const deadline = Date.now() + SCENARIO_BUDGET_MS;
  let worked = false;
  for (;;) {
    const view = (await runtime.statuses()).find((entry) => entry.sessionId === sessionId)?.view;
    if ((view?.activeForegroundBashToolCallIds.length ?? 0) > 0) return;
    if (isWorkingStatus(view)) worked = true;
    else if (worked) throw new Error(`Session ${sessionId} ended its turn without a foreground bash call`);
    if (Date.now() >= deadline) throw new Error(`Session ${sessionId} ran no foreground bash call within ${SCENARIO_BUDGET_MS} ms`);
    await Bun.sleep(seams.pollMs ?? POLL_MS);
  }
}

/**
 * The stop scenario: a person stops a turn while its bash call runs, through the runtime's interrupt for the
 * session, and then sends one more message on the same session. The last wait also waits for `title`.
 */
async function stopAndContinue(runtime: ScenarioRuntime, sessionId: string, seams: ScenarioSeams, title: TitleRow): Promise<StopObservation & { readonly titleGenerated?: boolean }> {
  await runtime.send(sessionId, PROMPTS.stop);
  await bashRunning(runtime, sessionId, seams);
  await runtime.interrupt(sessionId);
  await settleSessions(runtime, sessionId, seams, { seenWork: true });
  const stopped = await runtime.blocks(sessionId);
  const interrupted = stopped.some((block) => block.kind === "system" && block.message === interruptedLabel("person"));
  const toolStatus = stopped.flatMap((block) => (block.kind === "tool" && block.name === "bash" ? [block.status] : []))[0];
  await runtime.send(sessionId, PROMPTS.stopFollowUp);
  const settled = await settleSessions(runtime, sessionId, seams, { title });
  const after = await runtime.blocks(sessionId);
  const followUp = after.findLastIndex((block) => block.kind === "userMessage");
  const followUpReplied = followUp >= 0 && after.slice(followUp + 1).some((block) => block.kind === "text" && block.content.trim().length > 0);
  return { interrupted, toolStatus, followUpReplied, ...settled };
}

/** Why a stop observation fails the scenario, or nothing when the stop went as a person expects. */
function stopFailures(stop: StopObservation): string[] {
  return [
    ...(stop.interrupted ? [] : ["The transcript shows no interrupted turn end"]),
    ...(stop.toolStatus === "interrupted" ? [] : [`The bash call ended ${stop.toolStatus ?? "absent"}, not interrupted`]),
    ...(stop.followUpReplied ? [] : ["The follow-up message got no reply"]),
  ];
}

/** What a run left in the config directories: CLI processes that still run on them, and the scenario project's
 *  directory. The CLI names a project's directory after its path, so that name holds the scenario root's unique
 *  name. */
function configLeftovers(configDirs: readonly string[], root: string): ScenarioCleanup {
  const records = configDirs.flatMap((configDir) => {
    try {
      return readdirSync(join(configDir, "sessions"));
    } catch {
      // No CLI ever ran on this config directory.
      return [];
    }
  });
  const cliProcesses = records.filter((name) => {
    const pid = /^(\d+)\.json$/u.exec(name)?.[1];
    return pid !== undefined && isProcessAlive(Number(pid));
  }).length;
  const projectDirectory = configDirs.some((configDir) => {
    try {
      return readdirSync(join(configDir, "projects")).some((name) => name.includes(basename(root)));
    } catch {
      return false;
    }
  });
  return { cliProcesses, projectDirectory };
}

function cleanupFailures(cleanup: ScenarioCleanup): string[] {
  return [
    ...(cleanup.cliProcesses === 0 ? [] : [`${cleanup.cliProcesses} Claude CLI processes still run`]),
    ...(cleanup.projectDirectory ? ["The CLI project directory of the scenario remains"] : []),
  ];
}

/** What the runtime scenarios observed before the runtime closed. */
type RuntimeObservation = Omit<ScenarioReport, "scenario" | "completed" | "durationMs" | "cleanup" | "failure"> & { readonly failures: readonly string[] };

/**
 * Drives one runtime scenario and settles every session it started before the caller closes the runtime. The
 * runtime titles each scenario's catalog row from the chat's first message.
 */
async function observeRuntimeScenario(name: ScenarioName, runtime: ScenarioRuntime, seams: ScenarioSeams): Promise<RuntimeObservation> {
  const firstWords = name === "workflow" ? PROMPTS.workflow : PROMPTS[name];
  const sessionId = await runtime.openChat(name === "workflow");
  const title: TitleRow = { sessionId, quickTitle: quickTitleFromMessage(firstWords).full };
  let observed: Pick<ScenarioReport, "titleGenerated" | "stop">;
  const failures: string[] = [];
  if (name === "stop") {
    const { titleGenerated, ...stop } = await stopAndContinue(runtime, sessionId, seams, title);
    observed = { stop, ...(titleGenerated === undefined ? {} : { titleGenerated }) };
    failures.push(...stopFailures(stop));
  } else {
    await runtime.send(sessionId, firstWords);
    observed = await settleSessions(runtime, sessionId, seams, { title });
  }
  if (observed.titleGenerated === false) failures.push("No generated title reached the session row");
  const workflowSessionId = name === "workflow" ? await runtime.workflowSession(sessionId) : undefined;
  if (name === "workflow" && workflowSessionId === undefined) failures.push("The chat launched no workflow");
  const summary = summarizeBlocks(await runtime.blocks(workflowSessionId ?? sessionId));
  if ((summary.errors ?? []).length > 0) failures.push("The transcript holds error notices");
  return { sessionId: workflowSessionId ?? sessionId, ...summary, ...observed, failures };
}

/**
 * Runs one named scenario through production composition in an isolated project, on the Claude login of the
 * `claude-sdk` profile of the account home, and removes the project and the scenario's temporary root afterwards.
 * `chat`, `child`, and `title` send one chat message; `workflow` asks a chat to launch
 * the project's greeting-check file with Workflows On; `stop` interrupts a
 * running bash call and then sends one more message. Every runtime scenario closes the runtime only after every
 * session it started is at rest and its generated title landed, and fails when no generated title landed within
 * the title wait. Every scenario fails when a CLI process or the project's CLI directory remains afterwards.
 */
export async function runScenario(
  name: ScenarioName,
  options: ScenarioOptions & { readonly launcher: LauncherScope },
  seams: ScenarioSeams = {},
): Promise<ScenarioReport> {
  const started = Date.now();
  const place = await prepareScenarioPlace(options);
  const report = (observed: Omit<ScenarioReport, "scenario" | "completed" | "durationMs" | "cleanup" | "failure">, failures: readonly string[]): ScenarioReport => {
    const cleanup = configLeftovers(place.configDirs, place.root);
    const all = [...failures, ...cleanupFailures(cleanup)];
    return { scenario: name, completed: all.length === 0, durationMs: Date.now() - started, ...observed, cleanup, ...(all.length === 0 ? {} : { failure: all.join("; ") }) };
  };
  try {
    if (place.configDirs.length === 0) return report({}, [`The claude-sdk profile of ${place.accountHome} has no Claude login. Run: flywheel claude-sdk setup --home ${place.accountHome} --login`]);
    const runtime = await (seams.openRuntime ?? openScenarioRuntime)(place, options.launcher);
    let observation: RuntimeObservation;
    try {
      observation = await observeRuntimeScenario(name, runtime, seams);
    } finally {
      await runtime.dispose();
    }
    const { failures, ...observed } = observation;
    return report(observed, failures);
  } catch (error) {
    return report({}, [error instanceof Error ? `${error.name}: ${error.message}` : String(error)]);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
}
