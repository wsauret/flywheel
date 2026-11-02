import { describe, expect, test } from "bun:test";
import type { LauncherScope } from "../../../../../../src/infra/process-supervisor.js";
import type { FrontendOutputBlock } from "../../../../../../src/protocol/app-service-types.js";
import type { StatusView } from "../../../../../../src/protocol/status-protocol-types.js";
import { runScenario } from "../../../../../../src/orchestration/modules/development/claude-sdk/scenarios.js";
import { quickTitleFromMessage } from "../../../../../../src/orchestration/session/session-title.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";

type ScenarioSeams = NonNullable<Parameters<typeof runScenario>[2]>;
type ScenarioRuntime = Awaited<ReturnType<NonNullable<ScenarioSeams["openRuntime"]>>>;

const temporaryDirectory = temporaryDirectories();
const noLaunch: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
  adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
  open: () => noLaunch,
  close: async () => ({ settled: true }),
};

/** A status at work or at rest; `bash` names the foreground bash calls that run. */
function status(working: boolean, bash: readonly string[] = []): StatusView {
  return {
    activity: working ? (bash.length > 0 ? "executing_tools" : "generating") : "idle", settledOutputPosition: null, connectionState: "connected",
    activityStartedAt: 0,
    activeSubagentCount: 0, waitingOnBackgroundWork: false, replyWaits: [], activeBackgroundCommands: [], activeForegroundBashToolCallIds: bash, processorHeldToolCallIds: [],
    startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null,
  };
}

/** A runtime that refuses every call and shows a generated title on every row; each test replaces the calls its scenario makes. */
function refusingRuntime(calls: string[]): ScenarioRuntime {
  const refuse = (call: string) => () => Promise.reject(new Error(`the scenario makes no ${call} call`));
  return {
    openChat: refuse("openChat"), workflowSession: refuse("workflowSession"), send: refuse("send"), interrupt: refuse("interrupt"), statuses: refuse("statuses"),
    title: async () => "Generated title", blocks: async () => [], async dispose() { calls.push("dispose"); },
  };
}

function run(name: Parameters<typeof runScenario>[0], runtime: ScenarioRuntime, seams: Omit<ScenarioSeams, "openRuntime"> = {}) {
  // The Claude CLI holds one login, in a scratch config directory.
  const configDir = temporaryDirectory("claude-sdk-scenario-");
  return runScenario(name, { accounts: () => [{ accountId: "uuid-person", identity: "person@example.com", configDir }], launcher: noLaunch }, { openRuntime: async () => runtime, pollMs: 0, restMs: 0, titleWaitMs: 0, ...seams });
}

describe("the scenario runner", () => {
  test("fails at once when the claude-sdk profile of the home has no Claude login, says how to add one, and opens no runtime", async () => {
    const calls: string[] = [];
    const report = await runScenario("chat", { accounts: () => [], launcher: noLaunch }, { openRuntime: async () => { calls.push("open"); return refusingRuntime(calls); } });

    expect(report).toMatchObject({ scenario: "chat", completed: false, failure: expect.stringContaining("has no Claude login. Run: flywheel claude-sdk setup --home ") });
    expect(calls).toEqual([]);
  });

  test.each([true, false])("waits for all sessions and requires a launched workflow (launched: %s)", async (launched) => {
    // The launched workflow works for two reads and rests. Its parent chat then starts a follow-up turn, as a
    // parent does when its workflow completes, and works for five rest times: a wait that watches only the
    // workflow would close the runtime during that turn.
    const restMs = 20;
    const calls: string[] = [];
    let reads = 0;
    let parentWorkUntil: number | undefined;
    const parentWorks = () => parentWorkUntil !== undefined && Date.now() < parentWorkUntil;
    const runtime: ScenarioRuntime = {
      ...refusingRuntime(calls),
      async openChat(workflows) { expect(workflows).toBe(true); return "parent-1"; },
      async send(sessionId, input) {
        expect(sessionId).toBe("parent-1");
        expect(input).toContain("claude-sdk-greeting.workflow.yaml by path");
      },
      workflowSession: async () => launched ? "workflow-1" : undefined,
      async statuses() {
        reads += 1;
        if (reads === 3) parentWorkUntil = Date.now() + 5 * restMs;
        return [{ sessionId: "workflow-1", view: status(reads <= 2) }, { sessionId: "parent-1", view: status(reads <= 2 || parentWorks()) }];
      },
      // The workflow's generated title lands on its parent chat's row: the workflow has no row of its own.
      title: async (sessionId) => (sessionId === "parent-1" ? "Generated title" : undefined),
      async dispose() { calls.push(parentWorks() ? "dispose while the parent works" : "dispose"); },
    };

    const report = await run("workflow", runtime, { pollMs: 1, restMs });

    expect(report).toMatchObject({ scenario: "workflow", completed: launched, sessionId: launched ? "workflow-1" : "parent-1", cleanup: { cliProcesses: 0, projectDirectory: false } });
    if (!launched) expect(report.failure).toContain("The chat launched no workflow");
    expect(calls).toEqual(["dispose"]);
  });
});

/**
 * A runtime whose chat turn works for one read and whose session row shows the quick title of the sent message,
 * as the runtime does at the first send, until `quickReads` reads have passed and the generated title lands.
 */
function titleRuntime(quickReads: number) {
  const calls: string[] = [];
  let sent = "";
  let statusReads = 0;
  let titleReads = 0;
  const runtime: ScenarioRuntime = {
    ...refusingRuntime(calls),
    openChat: async () => "session-1",
    async send(_sessionId, input) { sent = input; },
    async statuses() {
      statusReads += 1;
      return [{ sessionId: "session-1", view: status(statusReads === 1) }];
    },
    async title() {
      calls.push("title");
      titleReads += 1;
      return titleReads > quickReads ? "Greeting in one sentence" : quickTitleFromMessage(sent).full;
    },
  };
  return { runtime, calls };
}

describe("the title wait", () => {
  // The title request runs on its own query beside the turn, so closing the runtime when the turn rests would abort it.
  test.each(["chat", "child", "title"] as const)("the %s scenario waits for the generated title before it disposes the runtime", async (name) => {
    const { runtime, calls } = titleRuntime(3);

    const report = await run(name, runtime, { titleWaitMs: 60_000 });

    expect(report).toMatchObject({ scenario: name, completed: true, titleGenerated: true });
    expect(calls).toEqual(["title", "title", "title", "title", "dispose"]);
  });

  test("reports itself incomplete when only the quick title reaches the session row", async () => {
    const { runtime, calls } = titleRuntime(Number.POSITIVE_INFINITY);

    const report = await run("title", runtime, { titleWaitMs: 0 });

    expect(report).toMatchObject({ scenario: "title", completed: false, titleGenerated: false, failure: "No generated title reached the session row" });
    expect(calls.at(-1)).toBe("dispose");
  });
});

const BASH_BLOCK = { kind: "tool", id: "toolu_1", name: "bash", presentation: { name: "Bash", detail: "sleep 60" }, timestamp: 2 } as const;

/**
 * A runtime in which the stop prompt starts a foreground bash call, which ends with `toolStatus` once the
 * session is interrupted, and in which the follow-up message gets `reply`.
 */
function stopRuntime(toolStatus: "interrupted" | "completed", reply: string) {
  const calls: string[] = [];
  let phase: "turn" | "stopped" | "follow-up" = "turn";
  let reads = 0;
  const runtime: ScenarioRuntime = {
    ...refusingRuntime(calls),
    openChat: async () => "session-1",
    async send() {
      calls.push("send");
      if (phase === "stopped") {
        phase = "follow-up";
        reads = 0;
      }
    },
    async interrupt(sessionId) {
      calls.push(`interrupt ${sessionId}`);
      phase = "stopped";
    },
    async statuses() {
      reads += 1;
      const view = phase === "turn" ? status(true, reads > 1 ? ["toolu_1"] : []) : status(phase === "follow-up" && reads === 1);
      return [{ sessionId: "session-1", view }];
    },
    async blocks() {
      const stopped: FrontendOutputBlock[] = [
        { kind: "userMessage", id: "u1", content: "run", timestamp: 1, pending: false, injected: false },
        { ...BASH_BLOCK, status: toolStatus },
        { kind: "system", id: "s1", message: "Interrupted", level: "info", timestamp: 3 },
      ];
      return phase === "follow-up"
        ? [...stopped, { kind: "userMessage", id: "u2", content: "again", timestamp: 4, pending: false, injected: false }, { kind: "text", id: "t1", content: reply, timestamp: 5 }]
        : stopped;
    },
  };
  return { runtime, calls };
}

describe("the stop scenario", () => {
  test("interrupts the session while its bash call runs, and then sends the follow-up after every session rested", async () => {
    const { runtime, calls } = stopRuntime("interrupted", "ready");

    const report = await run("stop", runtime);

    expect(report).toMatchObject({ scenario: "stop", completed: true, sessionId: "session-1", stop: { interrupted: true, toolStatus: "interrupted", followUpReplied: true } });
    expect(calls).toEqual(["send", "interrupt session-1", "send", "dispose"]);
  });

  test("fails when the bash call finished instead of being cut, or the follow-up got no reply", async () => {
    const { runtime } = stopRuntime("completed", " ");

    const report = await run("stop", runtime);

    expect(report).toMatchObject({
      completed: false, stop: { interrupted: true, toolStatus: "completed", followUpReplied: false },
      failure: "The bash call ended completed, not interrupted; The follow-up message got no reply",
    });
  });

  test("fails at once when the turn ends without running a foreground bash call", async () => {
    const calls: string[] = [];
    let reads = 0;
    const runtime: ScenarioRuntime = {
      ...refusingRuntime(calls),
      openChat: async () => "session-1",
      async send() { calls.push("send"); },
      async statuses() {
        reads += 1;
        return [{ sessionId: "session-1", view: status(reads === 1) }];
      },
    };

    const report = await run("stop", runtime);

    expect(report).toMatchObject({ completed: false, failure: "Error: Session session-1 ended its turn without a foreground bash call" });
    expect(calls).toEqual(["send", "dispose"]);
  });
});
