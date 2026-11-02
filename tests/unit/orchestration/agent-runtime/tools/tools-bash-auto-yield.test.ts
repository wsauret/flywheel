import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { backgroundLogPath } from "../../../../helpers/background-log-path.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createBashDefinition, parseBashResultDetails } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { createForegroundBashHoldController, type ForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { makeMockOps, makeMockOwnedProcess, ownedSpawnProbe, type OwnedExit } from "./_bash-fixtures.js";
import { capabilityAccessHolding, makeContext } from "./_fixtures.js";

beforeAll(loadBashParser);
const temporaryDirectory = temporaryDirectories();

// A background command writes its log into the session scratch directory, so
// each case gets one that its afterEach removes.
function backgroundContext(overrides?: Parameters<typeof makeContext>[0]): ReturnType<typeof makeContext> {
  return makeContext({
    capabilityAccess: capabilityAccessHolding(["background-commands"]),
    scratchDir: temporaryDirectory("flywheel-bash-auto-yield-"),
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }),
    ...overrides,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

describe("bash result details", () => {
  it("accepts current variants and valid historical records", () => {
    expect(parseBashResultDetails({ background: false, exitCode: 0, durationMs: 1 })).toEqual({ background: false, exitCode: 0, durationMs: 1 });
    expect(parseBashResultDetails({ background: false, exitCode: 0, durationMs: 1, mutation: { version: 1, files: [], omissions: [] } })).toEqual({ background: false, exitCode: 0, durationMs: 1 });
    expect(parseBashResultDetails({ background: true, releaseReason: "runtime_cap", durationMs: 2 })).toEqual({ background: true, releaseReason: "runtime_cap", durationMs: 2 });
    expect(parseBashResultDetails({ background: true, releaseReason: "user_detach", durationMs: 3 })).toEqual({ background: true, releaseReason: "user_detach", durationMs: 3 });
    expect(parseBashResultDetails({ background: true, releaseReason: "replacement", durationMs: 5 })).toEqual({ background: true, releaseReason: "replacement", durationMs: 5 });
    expect(parseBashResultDetails({ background: true })).toEqual({ background: true });
    expect(parseBashResultDetails({ exitCode: 0, durationMs: 4 })).toEqual({ exitCode: 0, durationMs: 4 });
    expect(parseBashResultDetails({ background: true, durationMs: 6 })).toEqual({ background: true, durationMs: 6 });
    expect(parseBashResultDetails({})).toEqual({});
  });

  it("rejects impossible release evidence", () => {
    expect(() => parseBashResultDetails({ releaseReason: "runtime_cap", durationMs: 1 })).toThrow();
    expect(() => parseBashResultDetails({ background: false, exitCode: 0, durationMs: 1, releaseReason: "user_detach" })).toThrow();
    expect(() => parseBashResultDetails({ background: true, releaseReason: "runtime_cap" })).toThrow();
  });
});

describe("bash automatic yield", () => {
  it("transfers a foreground command at the runtime cap and ignores turn abort after transfer", async () => {
    const exit = deferred<OwnedExit>();
    const turn = new AbortController();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 8080, exited: exit.promise }));
    const def = createBashDefinition({
      operations: makeMockOps({
        writeScript: async (_path, content) => {
          const logPath = backgroundLogPath(content);
          if (logPath) await Bun.write(logPath, "");
          return content.length;
        },
      }),
      totalYieldMs: 5,
    });

    const result = await def.execute({ command: "bun slow-task.ts" }, backgroundContext({
      executionCwd: "/mock",
      signal: turn.signal,
      backgroundTasks: registry,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      toolUseId: "toolu_yield",
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result).toMatchObject({ details: { background: true, releaseReason: "runtime_cap" } });
    expect(spawn.launches[0]).toMatchObject({ stdin: "ignore", handover: true });
    expect(registry.activeTaskCount()).toBe(1);
    // A finite command that outran its call still owes its result: a bounded
    // run waits for it before it completes.
    expect(registry.awaitedTaskCount()).toBe(1);
    turn.abort();
    expect(spawn.terminated).toEqual([]);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("tracks an explicit background launch as a service that a bounded run does not await", async () => {
    const exit = deferred<OwnedExit>();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 8081, exited: exit.promise }));
    const def = createBashDefinition({
      operations: makeMockOps({
        writeScript: async (_path, content) => {
          const logPath = backgroundLogPath(content);
          if (logPath) await Bun.write(logPath, "");
          return content.length;
        },
      }),
      postExitDrainGraceMs: 0,
    });

    const result = await def.execute({ command: "python3 server.py", background: true }, backgroundContext({
      backgroundTasks: registry,
      toolUseId: "toolu_service",
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result.details).toMatchObject({ background: true });
    expect(registry.activeTaskCount()).toBe(1);
    expect(registry.awaitedTaskCount()).toBe(0);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    await waitUntil(() => registry.activeTaskCount() === 0);
  });

  it("transfers a held foreground command when the user releases its raw tool call ID", async () => {
    const exit = deferred<OwnedExit>();
    const activeIds: (readonly string[])[] = [];
    const foregroundBashHold = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun slow-task.ts" }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_detach",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
    }));
    await waitUntil(() => activeIds.length === 1);

    expect(activeIds).toEqual([["toolu_detach"]]);
    expect(foregroundBashHold.release("toolu_detach")).toBe(true);
    const result = await execution;
    expect(activeIds).toEqual([["toolu_detach"], []]);
    expect(result.details).toMatchObject({ background: true, releaseReason: "user_detach", durationMs: expect.any(Number) });
    expect(registry.activeTaskCount()).toBe(1);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("shows Detach while its launch has not started, and moves the command to the background once it runs", async () => {
    const exit = deferred<OwnedExit>();
    const launched = deferred<void>();
    const activeIds: (readonly string[])[] = [];
    const foregroundBashHold = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun dev-server.ts" }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_queued",
      spawnOwned: async () => {
        await launched.promise;
        return makeMockOwnedProcess({ exited: exit.promise });
      },
    }));
    await waitUntil(() => activeIds.length === 1);
    expect(activeIds).toEqual([["toolu_queued"]]);

    // Pressed while the launch still waits: the command transfers as it starts.
    expect(foregroundBashHold.release("toolu_queued")).toBe(true);
    launched.resolve();
    const result = await execution;

    expect(result.details).toMatchObject({ background: true, releaseReason: "user_detach" });
    expect(registry.activeTaskCount()).toBe(1);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("moves a held command to the background for a replacement and settles the move once the registry tracks it", async () => {
    const exit = deferred<OwnedExit>();
    const activeIds: (readonly string[])[] = [];
    const backgroundToolUseIds: (readonly (string | undefined)[])[] = [];
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification() {},
      onChange: (commands) => backgroundToolUseIds.push(commands.map((command) => command.toolUseId)),
    });
    // The hold's cleanup is the command's report that the move is complete,
    // so the registry must track the command by then.
    const trackedAtReport: number[] = [];
    const controller = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const foregroundBashHold: ForegroundBashHoldController = {
      ...controller,
      register: (toolUseId) => {
        const hold = controller.register(toolUseId);
        return { ...hold, cleanup: () => { trackedAtReport.push(registry.activeTaskCount()); hold.cleanup(); } };
      },
    };
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun dev-server.ts" }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_replaced",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
    }));
    await waitUntil(() => activeIds.length === 1);

    await foregroundBashHold.transferForReplacement();
    expect(trackedAtReport).toEqual([1]);
    const result = await execution;

    expect(result.content).toMatch(/^Command is still running and transferred to managed process bash-bg-\w+ because the runtime was replaced\.\nA background_command_notification/);
    expect(result.details).toMatchObject({ background: true, releaseReason: "replacement", durationMs: expect.any(Number) });
    expect(activeIds).toEqual([["toolu_replaced"], []]);
    expect(backgroundToolUseIds.at(-1)).toEqual(["toolu_replaced"]);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("keeps an explicit deadline after user Detach transfer", async () => {
    const exit = deferred<OwnedExit>();
    const activeIds: (readonly string[])[] = [];
    const notifications: string[] = [];
    const foregroundBashHold = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      pid: 8085,
      exited: exit.promise,
      terminate: async () => {
        const settled: OwnedExit = { code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(settled);
        return settled;
      },
    }));
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 50 });

    const execution = def.execute({ command: "bun slow-task.ts", timeout: 0.2 }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_detach_deadline",
      spawnOwned: spawn.spawnOwned,
    }));
    await waitUntil(() => activeIds.length === 1);
    expect(foregroundBashHold.release("toolu_detach_deadline")).toBe(true);

    const result = await execution;
    expect(result.details).toMatchObject({ background: true, releaseReason: "user_detach" });
    expect(registry.activeTaskCount()).toBe(1);
    await waitUntil(() => notifications.length === 1, 500);
    expect(spawn.terminated).toEqual([8085]);
    expect(notifications[0]).toContain("exited with code 143");
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("terminates and settles an aborted candidate before background transfer", async () => {
    const exit = deferred<OwnedExit>();
    const launched = deferred<void>();
    const turn = new AbortController();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => {
      launched.resolve();
      return makeMockOwnedProcess({ pid: 8082, exited: exit.promise, terminate: async () => exit.promise });
    });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun slow-task.ts" }, backgroundContext({
      signal: turn.signal,
      backgroundTasks: registry,
      toolUseId: "toolu_pre_transfer_abort",
      spawnOwned: spawn.spawnOwned,
    }));
    await launched.promise;
    turn.abort();
    expect(registry.activeTaskCount()).toBe(0);
    expect(notifications).toEqual([]);

    exit.resolve({ code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" });
    await expect(execution).resolves.toMatchObject({ outcome: "interrupted" });
    expect(spawn.terminated).toEqual([8082]);
    expect(registry.activeTaskCount()).toBe(0);
    expect(notifications).toEqual([]);
  });

  it("does not terminate session-owned work when abort follows transfer", async () => {
    const exit = deferred<OwnedExit>();
    const turn = new AbortController();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 8083, exited: exit.promise }));
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 1 });

    const result = await def.execute({ command: "bun slow-task.ts" }, backgroundContext({
      signal: turn.signal,
      backgroundTasks: registry,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      toolUseId: "toolu_post_transfer_abort",
      spawnOwned: spawn.spawnOwned,
    }));
    expect(result.content).toContain("reached the runtime cap");
    expect(registry.activeTaskCount()).toBe(1);

    turn.abort();
    await Promise.resolve();
    expect(spawn.terminated).toEqual([]);
    expect(registry.activeTaskCount()).toBe(1);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("settles a natural exit racing abort with one termination request and no transfer", async () => {
    const exit = deferred<OwnedExit>();
    const launched = deferred<void>();
    const turn = new AbortController();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const spawn = ownedSpawnProbe(() => {
      launched.resolve();
      return makeMockOwnedProcess({ pid: 8084, exited: exit.promise, terminate: async () => exit.promise });
    });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun quick-task.ts" }, backgroundContext({
      signal: turn.signal,
      backgroundTasks: registry,
      spawnOwned: spawn.spawnOwned,
    }));
    await launched.promise;
    turn.abort();
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });

    await expect(execution).resolves.toMatchObject({ outcome: "interrupted" });
    expect(spawn.terminated).toEqual([8084]);
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("keeps an explicit deadline after automatic transfer", async () => {
    const exit = deferred<OwnedExit>();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      pid: 8081,
      exited: exit.promise,
      terminate: async () => {
        const settled: OwnedExit = { code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(settled);
        return settled;
      },
    }));
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 5 });

    const result = await def.execute({ command: "bun slow-task.ts", timeout: 0.02 }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      toolUseId: "toolu_deadline",
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result.content).toContain("reached the runtime cap");
    expect(registry.activeTaskCount()).toBe(1);
    await waitUntil(() => notifications.length === 1, 100);
    expect(spawn.terminated).toEqual([8081]);
    expect(notifications[0]).toContain("exited with code 143");
    expect(registry.activeTaskCount()).toBe(0);
  });

  // A command whose deadline is inside the hold window holds for its whole
  // run, never transferring at the cap.
  it("holds a command whose deadline is inside the hold window for its whole run", async () => {
    const exit = deferred<OwnedExit>();
    const activeIds: (readonly string[])[] = [];
    const foregroundBashHold = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "sleep 15; echo step-1", timeout: 30 }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_short_deadline",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
    }));
    await waitUntil(() => activeIds.length === 1);
    expect(activeIds).toEqual([["toolu_short_deadline"]]);

    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    const result = await execution;
    expect(activeIds).toEqual([["toolu_short_deadline"], []]);
    expect(result.details).toMatchObject({ background: false, exitCode: 0 });
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("transfers a held command whose deadline is inside the hold window when the user releases it", async () => {
    const exit = deferred<OwnedExit>();
    const activeIds: (readonly string[])[] = [];
    const foregroundBashHold = createForegroundBashHoldController((ids) => activeIds.push(ids));
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const execution = def.execute({ command: "bun slow-task.ts", timeout: 30 }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold,
      toolUseId: "toolu_short_detach",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
    }));
    await waitUntil(() => activeIds.length === 1);
    expect(foregroundBashHold.release("toolu_short_detach")).toBe(true);

    const result = await execution;
    expect(result.details).toMatchObject({ background: true, releaseReason: "user_detach" });
    expect(registry.activeTaskCount()).toBe(1);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
  });

  it("keeps a deadline before the yield threshold in the foreground", async () => {
    const exit = deferred<OwnedExit>();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      exited: exit.promise,
      terminate: async () => {
        const settled: OwnedExit = { code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(settled);
        return settled;
      },
    }));
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 25 });

    const result = await def.execute({ command: "bun bounded.ts", timeout: 0.005 }, backgroundContext({
      backgroundTasks: registry,
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("timed out");
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("returns a natural exit before the explicit deadline as foreground-complete", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    // The mock exits immediately; the deadline and yield threshold only need
    // their ordering (deadline inside the foreground window), and generous
    // values keep a slow CI runner from firing the deadline first.
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 10_000 });

    const result = await def.execute({ command: "bun quick.ts", timeout: 2 }, backgroundContext({
      backgroundTasks: registry,
      handoff: { onContent() {}, readCommandEvidence: async () => [] },
      spawnOwned: ownedSpawnProbe().spawnOwned,
      toolUseId: "toolu_quick",
    }));

    expect(result.content).toContain("[exit code: 0]");
    expect(result.content).toContain("[toolUseId: toolu_quick]");
    expect(result.details).not.toMatchObject({ background: true });
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("omits the command citation when the handoff has no command-evidence reader", async () => {
    // A subagent handoff has no reader, so no check would ever read the id.
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 10_000 });

    const result = await def.execute({ command: "bun quick.ts", timeout: 2 }, backgroundContext({
      backgroundTasks: registry,
      handoff: { onContent() {} },
      spawnOwned: ownedSpawnProbe().spawnOwned,
      toolUseId: "toolu_unread",
    }));

    expect(result.content).toContain("[exit code: 0]");
    expect(result.content).not.toContain("[toolUseId:");
  });

  it.each([
    [true, false],
    [undefined, true],
  ] as const)("uses raw_output=%s for a managed foreground natural exit", async (rawOutput, compressed) => {
    const output = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n");
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} });
    const def = createBashDefinition({
      operations: makeMockOps({
        writeScript: async (_path, content) => {
          const logPath = backgroundLogPath(content);
          if (logPath) await Bun.write(logPath, output);
          return content.length;
        },
      }),
      totalYieldMs: 25,
    });

    const result = await def.execute(
      { command: "print-lines", ...(rawOutput === undefined ? {} : { raw_output: rawOutput }) },
      backgroundContext({
        backgroundTasks: registry,
        foregroundBashHold: createForegroundBashHoldController(() => {}),
        spawnOwned: ownedSpawnProbe().spawnOwned,
        toolUseId: `toolu_raw_${String(rawOutput)}`,
      }),
    );

    if (typeof result.content !== "string") throw new Error("bash answers with text");
    expect(result.content.includes("lines omitted")).toBe(compressed);
    expect(result.content.includes("line 150")).toBe(!compressed);
    if (rawOutput) expect(result.content).toBe(`${output}\n[exit code: 0]`);
    else expect(result.fullContent).toBe(output);
    expect(registry.activeTaskCount()).toBe(0);
  });
});

describe("bash live output in the foreground hold", () => {
  it("streams a held command's tail live before it exits and records only its settled output", async () => {
    const exit = deferred<OwnedExit>();
    const streamed: string[] = [];
    const recorded: string[] = [];
    let logPath = "";
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification() {},
      onExecutionOutput: (_toolUseId, output) => streamed.push(output),
      onExecutionOutputRecorded: (_toolUseId, output) => { recorded.push(output); },
    });
    const def = createBashDefinition({
      executionOutputThrottleMs: 5,
      totalYieldMs: 10_000,
      operations: makeMockOps({
        writeScript: async (_path, content) => {
          logPath = backgroundLogPath(content) ?? "";
          if (logPath) await Bun.write(logPath, "");
          return content.length;
        },
      }),
    });
    const execution = def.execute({ command: "make test" }, backgroundContext({
      backgroundTasks: registry,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
      toolUseId: "toolu_held",
    }));

    await waitUntil(() => logPath !== "");
    await Bun.write(logPath, "tick 1\n");
    await waitUntil(() => streamed.at(-1) === "tick 1\n");
    await Bun.write(logPath, "tick 1\ntick 2\n");
    await waitUntil(() => streamed.at(-1) === "tick 1\ntick 2\n");
    // Nothing a running command prints becomes history.
    expect(recorded).toEqual([]);

    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    const result = await execution;
    expect(result.content).toContain("tick 2");
    expect(result.executionOutputTail).toBe("tick 1\ntick 2\n");
    expect(recorded).toEqual([]);
  });
});

/** A held command settles in its tool call through the same result, spool,
 *  and drain rules as any foreground command. */
describe("bash held foreground settlement", () => {
  function heldContext(overrides: Parameters<typeof makeContext>[0] & { readonly toolUseId: string }): ReturnType<typeof makeContext> {
    return backgroundContext({ foregroundBashHold: createForegroundBashHoldController(() => {}), ...overrides });
  }

  it("ends a held command at its deadline and reports the timeout", async () => {
    const exit = deferred<OwnedExit>();
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      pid: 8090,
      exited: exit.promise,
      terminate: async () => {
        const settled = { code: 143, signal: "SIGTERM" as const, statusOf: "payload" as const, ownership: "surrendered" as const };
        exit.resolve(settled);
        return settled;
      },
    }));
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const result = await def.execute({ command: "sleep 15", timeout: 0.02 }, heldContext({ toolUseId: "toolu_held_deadline", spawnOwned: spawn.spawnOwned }));

    expect(spawn.terminated).toEqual([8090]);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("[Command timed out after 0.02s; killed]");
    expect(result.content).toContain("[exit code: 124]");
    expect(result.details).toMatchObject({ background: false, exitCode: 124 });
  });

  it("waits for a launch's stderr that arrives after the exit", async () => {
    const encoder = new TextEncoder();
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode("error: the launch failed\n"));
          controller.close();
        }, 20);
      },
    });
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000 });

    const result = await def.execute({ command: "failing-launch" }, heldContext({
      toolUseId: "toolu_held_stderr",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({
        stderr,
        exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" }),
      })).spawnOwned,
    }));

    expect(result.content).toContain("[stderr] error: the launch failed");
    expect(result.content).toContain("[exit code: 1]");
  });

  it("settles within the post-exit grace when stderr never ends", async () => {
    const def = createBashDefinition({ operations: makeMockOps(), totalYieldMs: 60_000, postExitDrainGraceMs: 10 });

    const result = await def.execute({ command: "leaves-stderr-open" }, heldContext({
      toolUseId: "toolu_held_open_stderr",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ stderr: new ReadableStream<Uint8Array>() })).spawnOwned,
    }));

    expect(result.content).toContain("[exit code: 0]");
  });

  it("removes a settled command's script and small log, and keeps a log its result names", async () => {
    const scratchDir = temporaryDirectory("bash-held-spool-");
    const deleted: string[] = [];
    const run = (output: string, toolUseId: string) => createBashDefinition({
      totalYieldMs: 60_000,
      operations: makeMockOps({
        writeScript: async (scriptPath, content) => {
          await Bun.write(scriptPath, content);
          const logPath = backgroundLogPath(content);
          if (logPath) await Bun.write(logPath, output);
          return content.length;
        },
        deleteScript: async (scriptPath) => {
          deleted.push(scriptPath);
          fs.rmSync(scriptPath);
        },
      }),
    }).execute({ command: "print-output", raw_output: true }, heldContext({ toolUseId, scratchDir, spawnOwned: ownedSpawnProbe().spawnOwned }));

    const small = await run("small output\n", "toolu_held_small");
    expect(small.content).toContain("small output");
    expect(deleted).toHaveLength(1);
    expect(fs.readdirSync(scratchDir)).toEqual([]);

    const large = await run("x".repeat(2 * 1024 * 1024), "toolu_held_large");
    const named = large.retainedFullContent?.path;
    expect(named?.startsWith(scratchDir)).toBe(true);
    expect(deleted).toHaveLength(2);
    expect(fs.readdirSync(scratchDir)).toEqual([path.basename(named ?? "")]);
  });
});
