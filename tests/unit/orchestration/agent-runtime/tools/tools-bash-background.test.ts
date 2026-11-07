import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { backgroundLogPath } from "../../../../helpers/background-log-path.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyShellDetachment, loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";

const bashDefinition = createBashDefinition();
import { capabilityAccessFor } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createModulePolicy } from "../../../../../src/orchestration/config/module-policy.js";
import type { PersistentProcessRecord } from "../../../../../src/infra/persistent-process-manager.js";
import { makeMockOps, makeMockOwnedProcess, ownedSpawnProbe, type OwnedExit } from "./_bash-fixtures.js";
import { capabilityAccessHolding, makeContext, testGrant } from "./_fixtures.js";

/** Detached execution is capability-owned, so every case below that backgrounds
 *  a command carries a boundary that holds Background Commands. Cases about
 *  policy state their own. */
function backgroundContext(overrides?: Parameters<typeof makeContext>[0]): ReturnType<typeof makeContext> {
  return makeContext({
    capabilityAccess: capabilityAccessHolding(["background-commands"]),
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }),
    ...overrides,
  });
}

beforeAll(async () => {
  await loadBashParser();
});

/** How long a case may wait on a real subprocess lifecycle here.
 *
 *  These cases start an actual shell, and starting `powershell.exe` costs far
 *  more than starting `bash`, so Windows needs a wider budget while POSIX keeps
 *  a tight one. This is a ceiling on waiting, not a delay: a case that settles
 *  sooner returns sooner. */
const SUBPROCESS_BUDGET_MS = process.platform === "win32" ? 20_000 : 5_000;

async function waitUntil(predicate: () => boolean, timeoutMs = SUBPROCESS_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

function deferred<T>() {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

it("refuses explicit background execution without a session registry before spawn", async () => {
  const probe = ownedSpawnProbe();
  const result = await bashDefinition.execute(
    { command: "bun server.ts", background: true },
    makeContext({ capabilityAccess: capabilityAccessHolding(["background-commands"]), spawnOwned: probe.spawnOwned }),
  );
  expect(result).toMatchObject({ outcome: "error" });
  expect(result.content).toContain("no session process registry");
  expect(probe.launches).toHaveLength(0);
});

describe("bash tool: real background subprocess", () => {
  // Each case also uses tmpDir as its scratchDir. The tool then writes the
  // background script and log there, and the afterEach removes them.
  let tmpDir: string;
  let notifications: string[];
  let registry: ReturnType<typeof createBackgroundWorkRegistry>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bash-"));
    notifications = [];
    registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
  });

  afterEach(async () => {
    // A background command sits in the directory it was started in, and a live
    // process holds that directory open: Windows refuses to remove a directory
    // anything is still using. So the work a case started is waited for before
    // the directory it ran in is taken away, rather than removal racing a
    // shell that is still starting up.
    await waitUntil(() => registry.activeTaskCount() === 0);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  });

  it("registers backgrounded commands and notifies with exit code and log tail on completion", async () => {
    const ctx = backgroundContext({ executionCwd: tmpDir, scratchDir: tmpDir, backgroundTasks: registry, toolUseId: "toolu_bg1" });

    const result = await bashDefinition.execute({ command: "echo bg-done", background: true }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Running in background");
    expect(result.content).toContain("background_command_notification");
    expect(registry.activeTaskCount()).toBe(1);

    await waitUntil(() => notifications.length === 1);
    expect(registry.activeTaskCount()).toBe(0);
    const notification = notifications[0]!;
    expect(notification).toContain("<background_command_notification>");
    expect(notification).toContain("<tool_use_id>toolu_bg1</tool_use_id>");
    expect(notification).toContain("<status>completed</status>");
    expect(notification).toContain("bg-done");
  });

});

describe("bash tool: background process lifecycle", () => {
  it("records the sanitized last 1000 background log lines without expanding the notification", async () => {
    const exit = deferred<OwnedExit>();
    const notifications: string[] = [];
    const recorded: Array<{ toolUseId: string; output: string }> = [];
    const lines = Array.from({ length: 1005 }, (_, index) => `line-${index.toString().padStart(4, "0")}-${"x".repeat(16)}`);
    lines[5] = "durable-only-marker";
    lines[1004] = "\u001b[31mfinal-red\u001b[0m\u0000";
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => notifications.push(text),
      onExecutionOutputRecorded: (toolUseId, output) => { recorded.push({ toolUseId, output }); },
    });
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bg-recorded-tail-"));
    try {
      const def = createBashDefinition({
        tmpDir: localTmpDir,
        operations: makeMockOps({
          writeScript: async (_scriptPath, content) => {
            const logPath = backgroundLogPath(content);
            if (logPath) await Bun.write(logPath, `${lines.join("\n")}\n`);
            return content.length;
          },
        }),
      });

      await def.execute(
        { command: "bun long-task.ts", background: true },
        backgroundContext({
          executionCwd: "/mock",
          backgroundTasks: registry,
          toolUseId: "toolu_recorded_tail",
          spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
        }),
      );
      exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
      await waitUntil(() => notifications.length === 1);

      const settlementOutput = `${[...lines.slice(5, 1004), "final-red"].join("\n")}\n`;
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      for (const [index, entry] of recorded.entries()) {
        expect(entry.toolUseId).toBe("toolu_recorded_tail");
        expect(entry.output).not.toContain("\u001b");
        expect(entry.output).not.toContain("\u0000");
        if (index > 0) expect(entry.output).not.toBe(recorded[index - 1]?.output);
      }
      const settlement = recorded.filter((entry) => entry.output === settlementOutput);
      expect(settlement).toHaveLength(1);
      expect(settlement[0]!.output.split("\n").slice(0, -1)).toHaveLength(1000);
      expect(notifications[0]).not.toContain("durable-only-marker");
    } finally {
      fs.rmSync(localTmpDir, { recursive: true, force: true });
    }
  });

  it("terminates a registered background command through its container owner and, after it settled, tells the model that a person stopped it", async () => {
    const exit = deferred<OwnedExit>();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bg-kill-"));
    try {
      const def = createBashDefinition({
        tmpDir: localTmpDir,
        operations: makeMockOps({
          writeScript: async (_scriptPath, content) => {
            const logPath = backgroundLogPath(content);
            if (logPath) await Bun.write(logPath, "last useful line\n");
            return content.length;
          },
        }),
      });
      const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 777, exited: exit.promise }));
      const ctx = backgroundContext({ executionCwd: "/mock", backgroundTasks: registry, toolUseId: "toolu_kill", spawnOwned: spawn.spawnOwned });

      await def.execute({ command: "bun long-task.ts", background: true }, ctx);
      registry.terminate("toolu_kill");

      // One request to the one owner: the escalation to SIGKILL is the owned
      // container's own business, not a second signalling path here.
      expect(spawn.terminated).toEqual([777]);
      expect(registry.activeTaskCount()).toBe(1);
      expect(notifications).toEqual([]);

      exit.resolve({ code: 143, signal: null, statusOf: "payload", ownership: "surrendered" });
      await waitUntil(() => notifications.length === 1);

      // The model reads a person's Stop as one, not as a failure of the command.
      expect(notifications[0]).toContain("<status>stopped</status>");
      expect(notifications[0]).toContain("A person stopped this work with Stop.");
      expect(notifications[0]).toContain("exited with code 143");
      expect(notifications[0]).toContain("last useful line");
    } finally {
      fs.rmSync(localTmpDir, { recursive: true, force: true });
    }
  });
});

describe("bash tool: background live execution output", () => {
  it("streams through the session registry's live channel, surviving turn and run abort until the background signal fires", async () => {
    const exit = deferred<OwnedExit>();
    const turn = new AbortController();
    const run = new AbortController();
    const background = new AbortController();
    const emitted: string[] = [];
    const live: string[] = [];
    const recorded: string[] = [];
    const notifications: string[] = [];
    let logPath = "";
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => notifications.push(text),
      onExecutionOutput: (_toolUseId, output) => live.push(output),
      onExecutionOutputRecorded: (_toolUseId, output) => { recorded.push(output); },
    });
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bg-tail-"));
    try {
      const def = createBashDefinition({
        tmpDir: localTmpDir,
        executionOutputThrottleMs: 5,
        operations: makeMockOps({
          writeScript: async (_scriptPath, content) => {
            logPath = backgroundLogPath(content) ?? "";
            if (logPath) await Bun.write(logPath, "");
            return content.length;
          },
        }),
      });
      const result = await def.execute({ command: "bun server.ts", background: true }, backgroundContext({
        executionCwd: "/mock",
        spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ exited: exit.promise })).spawnOwned,
        signal: turn.signal,
        disposalSignal: run.signal,
        backgroundSignal: background.signal,
        backgroundTasks: registry,
        toolUseId: "toolu_tail",
        onExecutionOutput: (text) => emitted.push(text),
      }));
      expect(result.details).toEqual({ background: true });

      await Bun.write(logPath, "start\u001b[");
      await waitUntil(() => live.length === 1);
      turn.abort();
      await Bun.write(logPath, "start\u001b[31mred\u001b[0m\n");
      await waitUntil(() => live.at(-1)?.includes("red") === true);
      expect(live.at(-1)).toBe("startred\n");

      // Run disposal (runner respawn) must not stop a session-scoped tail.
      run.abort();
      await Bun.write(logPath, `${"x".repeat(60 * 1024)}bounded-tail`);
      await waitUntil(() => live.at(-1)?.endsWith("bounded-tail") === true);
      expect(live.at(-1)!.length).toBeLessThanOrEqual(50 * 1024);
      expect(notifications).toEqual([]);
      // A running tail is shown, never recorded.
      expect(recorded).toEqual([]);

      // The background signal (session end) is what stops the tail.
      background.abort();
      const beforeAbortWrite = live.length;
      await Bun.write(logPath, `${"y".repeat(60 * 1024)}after-abort`);
      await Bun.sleep(15);
      expect(live).toHaveLength(beforeAbortWrite);

      exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
      await waitUntil(() => notifications.length === 1);
      // The per-turn channel received nothing: the tail streams through the registry.
      expect(emitted).toEqual([]);
      // The settled tail is the one durable record.
      expect(recorded).toHaveLength(1);
    } finally {
      fs.rmSync(localTmpDir, { recursive: true, force: true });
    }
  });
});

const FALLBACK_TMP = path.resolve("/fallback-tmp");

describe("bash tool: background artifact paths", () => {
  // The runtime joins these with the host separator, so the fixture states a
  // path that is already native: a POSIX literal would compare a mixed-separator
  // expectation against a normalized one.
  const scratchDir = path.resolve("/proj/.flywheel/sessions/s1/scratch");

  it("creates background scripts and logs in prepared scratch", async () => {
    const operations: string[] = [];
    const writes: string[] = [];
    const def = createBashDefinition({
      execPath: "/usr/local/bin/bun",
      tmpDir: FALLBACK_TMP,
      // A PATH without search programs: only the scratchpad is prepared.
      loginShellPath: () => "/scratch/without-search-programs",
      operations: makeMockOps({
        ensureDir: (dir) => { operations.push(`prepare:${dir}`); },
        writeScript: async (file, content) => {
          operations.push(`write:${file}`);
          writes.push(file, content);
          return content.length;
        },
      }),
    });

    const result = await def.execute({ command: "echo background", background: true }, backgroundContext({ executionCwd: "/mock", scratchDir, spawnOwned: ownedSpawnProbe().spawnOwned }));

    expect(operations[0]).toBe(`prepare:${scratchDir}`);
    expect(operations[1]!.startsWith(`write:${scratchDir}${path.sep}`)).toBe(true);
    expect(writes[0]!.startsWith(`${scratchDir}${path.sep}`)).toBe(true);
    expect(writes[1]).toContain(`${scratchDir}${path.sep}flywheel-agent-bg-`);
    expect(result.content).toContain("managed process");
    expect(result.content).not.toContain(FALLBACK_TMP);
  });

  it("creates background scripts and logs in injected tmpDir without scratch", async () => {
    const writes: string[] = [];
    const fallbackTmp = path.resolve("/fallback-tmp");
    const def = createBashDefinition({
      tmpDir: fallbackTmp,
      operations: makeMockOps({
        writeScript: async (file, content) => {
          writes.push(file, content);
          return content.length;
        },
      }),
    });

    const result = await def.execute({ command: "echo background", background: true }, backgroundContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned }));

    expect(writes[0]!.startsWith(`${fallbackTmp}${path.sep}`)).toBe(true);
    expect(writes[1]).toContain(`${fallbackTmp}${path.sep}flywheel-agent-bg-`);
    expect(result.content).toContain("managed process");
  });
});

describe("bash tool: background commands under capability policy", () => {
  /** The real policy over a throwaway config file: admission, refusal wording,
   *  and a mid-flight disable all behave as they do in production. */
  async function withPolicy(
    moduleIds: string,
    run: (policy: Awaited<ReturnType<typeof createModulePolicy>>, dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bg-policy-"));
    try {
      const configPath = path.join(dir, "flywheel.toml");
      await Bun.write(configPath, `modules = ${moduleIds}\n`);
      await run(await createModulePolicy({ configPath }), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses a trailing-ampersand command before any environment, scratch, script, spawn, or registration effect", async () => {
    await withPolicy('["skills"]', async (policy, dir) => {
      const operations: string[] = [];
      const notifications: string[] = [];
      const spawn = ownedSpawnProbe();
      const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
      const def = createBashDefinition({
        tmpDir: dir,
        execPath: "/usr/local/bin/flywheel",
        operations: makeMockOps({
          ensureDir: (target) => { operations.push(`ensureDir:${target}`); },
          writeScript: async (file, content) => { operations.push(`writeScript:${file}`); return content.length; },
          writeExecutable: async (file) => { operations.push(`writeExecutable:${file}`); },
        }),
      });
      const ctx = makeContext({
        executionCwd: dir,
        scratchDir: path.join(dir, "scratch"),
        backgroundTasks: registry,
        toolUseId: "toolu_denied",
        capabilityAccess: capabilityAccessFor(policy),
        spawnOwned: spawn.spawnOwned,
      });

      const refused = await def.execute({ command: "bun server.ts", background: true }, ctx);

      expect(refused.outcome).toBe("error");
      expect(refused.content).toContain("background-commands is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml");
      expect(refused.content).toContain("foreground");
      expect(operations).toEqual([]);
      expect(spawn.launches).toEqual([]);
      expect(registry.activeTaskCount()).toBe(0);
      expect(notifications).toEqual([]);

      // Foreground Bash is core: the same refusing policy still runs it.
      const foreground = await def.execute({ command: "echo hi" }, ctx);

      expect(foreground.outcome).toBe("ok");
      expect(spawn.launches).toHaveLength(1);
    });
  });

  it("keeps a command admitted before the disable running, stoppable, and settling its registry ownership", async () => {
    await withPolicy('["background-commands"]', async (policy, dir) => {
      const exit = deferred<OwnedExit>();
      const notifications: string[] = [];
      const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
      const def = createBashDefinition({
        tmpDir: dir,
        operations: makeMockOps({
          writeScript: async (_file, content) => {
            const logPath = backgroundLogPath(content);
            if (logPath) await Bun.write(logPath, "still useful\n");
            return content.length;
          },
        }),
      });
      const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 4242, exited: exit.promise }));

      const started = await def.execute({ command: "bun server.ts", background: true }, makeContext({
        executionCwd: dir,
        backgroundTasks: registry,
        toolUseId: "toolu_admitted",
        capabilityAccess: capabilityAccessFor(policy),
        spawnOwned: spawn.spawnOwned,
      }));

      expect(started.outcome).toBe("ok");
      expect(registry.activeTaskCount()).toBe(1);

      expect(await policy.select([])).toEqual({ ok: true });

      expect(registry.terminate("toolu_admitted")).toBe(true);
      expect(spawn.terminated).toEqual([4242]);
      exit.resolve({ code: 143, signal: null, statusOf: "payload", ownership: "surrendered" });
      await waitUntil(() => notifications.length === 1);

      expect(notifications[0]).toContain("<status>stopped</status>");
      expect(notifications[0]).toContain("still useful");
      expect(registry.activeTaskCount()).toBe(0);
    });
  });

  it("runs a detached command on an admitted grant after Background Commands was disabled under it", async () => {
    await withPolicy("[]", async (policy, dir) => {
      const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
      const def = createBashDefinition({ tmpDir: dir, operations: makeMockOps() });
      const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 5150 }));
      // The operation was admitted while the capability was held; the live
      // selection lost it before this call of the same operation.
      const grant = testGrant("a background shell command", ["background-commands"], ["background-commands"]);

      const result = await def.execute({ command: "bun server.ts", background: true }, makeContext({
        executionCwd: dir,
        backgroundTasks: registry,
        toolUseId: "toolu_granted",
        capabilityAccess: capabilityAccessFor(policy, grant),
        spawnOwned: spawn.spawnOwned,
      }));

      expect(result.outcome).toBe("ok");
      expect(spawn.launches).toHaveLength(1);
      expect(registry.activeTaskCount()).toBe(1);
    });
  });

  it("keeps an explicit background command's hard deadline", async () => {
    const exit = deferred<OwnedExit>();
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      pid: 5151,
      exited: exit.promise,
      terminate: async () => {
        const settled: OwnedExit = { code: 143, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(settled);
        return settled;
      },
    }));
    const def = createBashDefinition({ operations: makeMockOps() });

    const result = await def.execute({ command: "bun server.ts", background: true, timeout: 0.02 }, backgroundContext({
      backgroundTasks: registry,
      toolUseId: "toolu_background_deadline",
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result.content).toContain("Running in background");
    expect(registry.activeTaskCount()).toBe(1);
    await waitUntil(() => notifications.length === 1, 100);
    expect(spawn.terminated).toEqual([5151]);
    expect(notifications[0]).toContain("hard deadline");
    expect(registry.activeTaskCount()).toBe(0);
  });

  it("clears an explicit background deadline when the command exits first", async () => {
    const notifications: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notifications.push(text) });
    const spawn = ownedSpawnProbe();
    const def = createBashDefinition({ operations: makeMockOps() });

    const result = await def.execute({ command: "bun quick-server.ts", background: true, timeout: 0.02 }, backgroundContext({
      backgroundTasks: registry,
      toolUseId: "toolu_background_natural_exit",
      spawnOwned: spawn.spawnOwned,
    }));

    expect(result.content).toContain("Running in background");
    await waitUntil(() => notifications.length === 1, 100);
    await Bun.sleep(25);
    expect(spawn.terminated).toEqual([]);
    expect(notifications[0]).not.toContain("hard deadline");
    expect(registry.activeTaskCount()).toBe(0);
  });
});

describe("bash detachment classifier", () => {
  it("matches shell operators without treating redirection or arithmetic as jobs", () => {
    expect(classifyShellDetachment("echo hi &", false)).toBe("ambiguous");
    expect(classifyShellDetachment("echo hi &", true)).toBe("service_detach");
    expect(classifyShellDetachment("nohup server &", false)).toBe("service_detach");
    expect(classifyShellDetachment("echo hi 2>&1", false)).toBe("none");
    expect(classifyShellDetachment("value=$((1 & 2))", false)).toBe("none");
    expect(classifyShellDetachment("echo '&'", false)).toBe("none");
    expect(classifyShellDetachment("cat <<'EOF'\nignored &\nEOF\necho done", false)).toBe("none");
    expect(classifyShellDetachment("echo $(server &)", false)).toBe("ambiguous");
  });
});

describe("bash persistent execution admission", () => {
  const persistentRecord: PersistentProcessRecord = {
    id: "persistent:test",
    pid: 4321,
    command: ["bash", "-lc", "server"],
    spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
    startedAtMs: 0,
    status: "running",
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  it.each([
    [{ command: "server", persist_after_exit: "yes" }, "'persist_after_exit' must be a boolean"],
    [{ command: "server", background: false, persist_after_exit: true }, "requires 'background=true'"],
    [{ command: "server", mutates: true, persist_after_exit: true }, "'mutates=true' cannot be combined"],
    [{ command: "server", background: true, persist_after_exit: true, timeout: 1 }, "cannot be combined with 'timeout'"],
  ])("rejects invalid persistence input before all effects", async (input, message) => {
    const effects: string[] = [];
    const definition = createBashDefinition({
      operations: makeMockOps({
        ensureDir: () => { effects.push("scratch"); },
        writeScript: async () => { effects.push("script"); return 0; },
      }),
    });
    const result = await definition.execute(input, makeContext({
      scratchDir: "/scratch",
      admitPersistentProcess: () => { effects.push("admit"); return true; },
      persistentProcesses: {
        launch: async () => { effects.push("launch"); return persistentRecord; },
        list: async () => [],
        read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
        async stop() { return "terminated"; },
        async release() {},
        close() {},
      },
    }));
    expect(result.content).toContain(message);
    expect(effects).toEqual([]);
  });

  it("names persistence in the shell-backgrounding refusal only when persistence is offered", async () => {
    for (const persistentProcesses of [true, false]) {
      const result = await createBashDefinition({ persistentProcesses }).execute({ command: "python server.py &" }, makeContext());
      expect(result.outcome).toBe("error");
      expect(String(result.content)).toStartWith("Shell-level backgrounding was not executed.");
      expect(String(result.content).includes("persist_after_exit=true")).toBe(persistentProcesses);
    }
  });

  it("re-admits permission before scratch, environment, spool, or launch effects", async () => {
    const effects: string[] = [];
    const definition = createBashDefinition({
      persistentProcesses: true,
      // A PATH without search programs: only the scratchpad is prepared.
      loginShellPath: () => "/scratch/without-search-programs",
      operations: makeMockOps({ ensureDir: () => { effects.push("scratch"); } }),
    });
    const context = makeContext({
      scratchDir: "/scratch",
      admitPersistentProcess: () => { effects.push("admit"); return false; },
      persistentProcesses: {
        launch: async () => { effects.push("launch"); return persistentRecord; },
        list: async () => [],
        read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
        async stop() { return "terminated"; },
        async release() {},
        close() {},
      },
    });
    const refused = await definition.execute({ command: "server", background: true, persist_after_exit: true }, context);
    expect(refused.outcome).toBe("error");
    expect(effects).toEqual(["admit"]);

    context.admitPersistentProcess = () => { effects.push("admit"); return true; };
    const admitted = await definition.execute({ command: "server", persist_after_exit: true }, context);
    expect(admitted.content).toContain("persistent:test");
    expect(String(admitted.content)).toStartWith("Note: persist_after_exit=true implies background=true.\n");
    expect(effects).toEqual(["admit", "admit", "scratch", "launch"]);
  });
});

