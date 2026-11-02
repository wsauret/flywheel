import { describe, expect, it } from "bun:test";

import type { DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import { Log } from "../../../../../src/infra/log.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createShellRuntime } from "../../../../../src/orchestration/agent-runtime/tools/shell-runtime.js";
import { makeMockOps, makeMockOwnedProcess, ownedSpawnProbe, streamOf, type OwnedExit } from "./_bash-fixtures.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

// The runtime spools command output under its temporary directory.
const temporaryDirectory = temporaryDirectories();

function owner() {
  return createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "chat",
    enqueueNotification: () => {},
  }));
}

/** The message of a captured log record. */
function messageOf(record: DebugLogRecordInput): string | undefined {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string" ? payload.message : undefined;
}

class ObservableAbortSignal extends EventTarget implements AbortSignal {
  readonly aborted = false;
  readonly reason = undefined;
  onabort: ((this: AbortSignal, ev: Event) => void) | null = null;
  listeners = 0;

  throwIfAborted(): void {}

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    this.listeners++;
    super.addEventListener(type, callback, options);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    this.listeners--;
    super.removeEventListener(type, callback, options);
  }
}

describe("shell runtime host generation", () => {
  it("refuses launches after the owner closes", async () => {
    const background = owner();
    await background.close();

    expect(() => background.shell.runBackground({
      command: "late",
      foreground: false,
      rawOutput: false,
      context: { executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test" },
      spawnOwned: async () => { throw new Error("a closed runtime launched a command"); },
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
    })).toThrow("shell runtime is closed");
  });

  it("keeps shell lifecycle implementation behind the runtime boundary", async () => {
    const [bashSource, shellExecutionSource, managedCommandSource] = await Promise.all([
      Bun.file("src/orchestration/agent-runtime/tools/bash.ts").text(),
      Bun.file("src/orchestration/agent-runtime/tools/shell-execution.ts").text(),
      Bun.file("src/orchestration/agent-runtime/tools/managed-command.ts").text(),
    ]);
    const executionSource = shellExecutionSource + managedCommandSource;

    for (const source of [bashSource]) {
      expect(source).not.toContain("spawnOwned(");
      expect(source).not.toContain("owned.terminate(");
      expect(source).not.toContain("openForegroundSpool");
      expect(source).not.toContain("registry.track(");
    }
    expect(executionSource).toContain("spawnOwned(");
    expect(executionSource).toContain("owned.terminate(");
    expect(executionSource).toContain("registry.track(");
  });

  it("waits on one canonical terminal promise and cleans abort observation", async () => {
    const background = owner();
    let settle!: () => void;
    const done = new Promise<{ status: "completed"; content: string }>((resolve) => {
      settle = () => resolve({ status: "completed", content: "done" });
    });
    background.tasks.track({
      done,
      meta: { id: "shell-test-1", type: "background_command", description: "test" },
    });
    const signal = new ObservableAbortSignal();

    const waited = background.tasks.waitProcess("shell-test-1", { signal, timeoutMs: 100 });
    expect(background.shell.hasActiveCommands()).toBe(true);
    settle();
    expect(await waited).toBe(true);
    expect(background.shell.hasActiveCommands()).toBe(false);
    expect(signal.listeners).toBe(0);
    await background.close();
  });
  it("terminates and joins foreground work when the runtime closes", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    let settle!: () => void;
    const exited = new Promise<Awaited<ReturnType<ReturnType<typeof makeMockOwnedProcess>["terminate"]>>>((resolve) => {
      settle = () => resolve({ code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" });
    });
    let terminated = 0;
    const owned = makeMockOwnedProcess({
      exited,
      terminate: async () => {
        terminated++;
        settle();
        return exited;
      },
    });
    const started = Promise.withResolvers<void>();
    const execution = runtime.client.runForeground({
      command: "blocked",
      context: {
        executionCwd: "/scratch",
        userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test",
      },
      spawnOwned: async () => { started.resolve(); return owned; },
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
      timeoutSec: 60,
      rawOutput: false,
      postExitDrainGraceMs: 10,
    });
    await started.promise;
    expect(runtime.client.hasActiveCommands()).toBe(true);
    await runtime.close();
    expect((await execution).outcome).toBe("interrupted");
    expect(runtime.client.hasActiveCommands()).toBe(false);
    expect(terminated).toBe(1);
  });

  it("surfaces parent-side stderr when a command fails with no recorded output", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    const owned = makeMockOwnedProcess({
      stdout: streamOf(""),
      stderr: streamOf("error: Unexpected export\n    at src/infra/process-container.ts:308:1\n"),
      exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" }),
    });
    const result = await runtime.client.runForeground({
      command: "echo hello",
      context: {
        executionCwd: "/scratch",
        userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test",
      },
      spawnOwned: async () => owned,
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
      timeoutSec: 60,
      rawOutput: false,
      postExitDrainGraceMs: 10,
    });

    expect(result.content).toContain("(no output)");
    expect(result.content).toContain("[stderr] error: Unexpected export");
    expect(result.content).toContain("[exit code: 1]");
    await runtime.close();
  });

  it("keeps stderr out of the result when the command succeeded or spoke on stdout", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    const run = (owned: ReturnType<typeof makeMockOwnedProcess>) => runtime.client.runForeground({
      command: "echo hello",
      context: {
        executionCwd: "/scratch",
        userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test",
      },
      spawnOwned: async () => owned,
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
      timeoutSec: 60,
      rawOutput: false,
      postExitDrainGraceMs: 10,
    });

    const succeeded = await run(makeMockOwnedProcess({
      stdout: streamOf("hello\n"),
      stderr: streamOf("+ echo hello\n"),
      exited: Promise.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" }),
    }));
    expect(succeeded.content).toContain("hello");
    expect(succeeded.content).not.toContain("[stderr]");

    const failedWithOutput = await run(makeMockOwnedProcess({
      stdout: streamOf("partial work\n"),
      stderr: streamOf("+ failing-step\n"),
      exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" }),
    }));
    expect(failedWithOutput.content).toContain("partial work");
    expect(failedWithOutput.content).not.toContain("[stderr]");
    await runtime.close();
  });

  it.each(["held", "unheld"] as const)("keeps diagnostic-looking payload stderr in the %s command's result and live output", async (path) => {
    const records: DebugLogRecordInput[] = [];
    await Log.init({ forward: (record) => { records.push(record); } });
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    try {
      const decision = { type: "log.info", payload: { service: "process-termination", message: "termination requested", senderPid: 4242, container: 4242, target: -4242, signal: "SIGTERM", reason: "stop requested" } };
      const line = JSON.stringify(decision);
      const owned = makeMockOwnedProcess({
        pid: 4242,
        stdout: streamOf(""),
        // Split mid-record, as a pipe can deliver it.
        stderr: streamOf([line.slice(0, 30), `${line.slice(30)}\nflywheel: payload could not start\n`]),
        exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" }),
      });
      const liveOutput: string[] = [];
      const options = {
        command: "echo hello",
        context: {
          executionCwd: "/scratch",
          userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
          artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test",
          onExecutionOutput: (text: string) => { liveOutput.push(text); },
        },
        spawnOwned: async () => owned,
        env: {},
        operations: makeMockOps(),
        platform: "linux" as const,
        tempDir: temporaryDirectory("fw-shell-runtime-"),
        executionOutputThrottleMs: 0,
        rawOutput: false,
        postExitDrainGraceMs: 10,
      };
      const result = path === "unheld"
        ? await runtime.client.runForeground({ ...options, timeoutSec: 60 })
        : await runtime.client.runBackground({ ...options, context: { ...options.context, toolUseId: "held", foregroundBashHold: createForegroundBashHoldController(() => {}) }, foreground: true, totalYieldMs: 60_000 });

      expect(result.content).toContain(line);
      expect(result.content).toContain("flywheel: payload could not start");
      if (path === "unheld") {
        expect(liveOutput.join("")).toContain("flywheel: payload could not start");
        expect(liveOutput.join("")).toContain(line);
      }
      expect(records.filter((record) => messageOf(record) === "termination requested")).toEqual([]);
    } finally {
      await runtime.close();
      await Log.closeGlobal();
    }
  });

  it("lets an expired deadline own settlement even when termination outlasts the runtime cap", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    const exit = Promise.withResolvers<OwnedExit>();
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      exited: exit.promise,
      terminate: async () => {
        // Termination settles after the runtime cap would fire.
        setTimeout(() => exit.resolve({ code: 124, signal: "SIGKILL", statusOf: "payload", ownership: "surrendered" }), 25);
        return exit.promise;
      },
    }));

    let settledForeground = false;
    const result = await runtime.client.runBackground({
      command: "blocked",
      foreground: true,
      rawOutput: false,
      timeoutSec: 0.005,
      totalYieldMs: 15,
      onForegroundSettled: () => { settledForeground = true; },
      context: {
        executionCwd: "/scratch",
        userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test",
      },
      spawnOwned: spawn.spawnOwned,
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
    });

    expect(result.content).toContain("timed out");
    expect(settledForeground).toBe(true);
    await runtime.close();
  });

  it("removes provisional process state when launch fails", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const runtime = createShellRuntime(tasks);
    const launch = runtime.client.runBackground({
      command: "fails",
      foreground: false,
      rawOutput: false,
      context: { executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "shell-runtime-test", retrievalSessionId: "shell-runtime-test", sessionId: "shell-runtime-test" },
      spawnOwned: async () => { throw new Error("spawn rejected"); },
      env: {},
      operations: makeMockOps(),
      platform: "linux",
      tempDir: temporaryDirectory("fw-shell-runtime-"),
      executionOutputThrottleMs: 0,
    });

    await expect(launch).rejects.toThrow("spawn rejected");
    expect(tasks.processRecords()).toEqual([]);
    await runtime.close();
  });
});
