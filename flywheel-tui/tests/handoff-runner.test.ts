import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeHandoffRunner } from "../src/orchestration/handoff-runner";
import type { Engine, EngineRunner, EngineResult, RunnerOptions } from "../src/orchestration/engines/core/types";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { AuthContext } from "../src/infra/auth/auth-context";
import { HandoffMissingError, HandoffInvalidError } from "../src/workflows/queue/shared/handoff-reader";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "handoff-runner-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const AUTH: AuthContext = {
  openaiAuth: "api_key",
  anthropicApiKey: "test-key",
  openaiApiKey: undefined,
};

// Lightweight fake runner + engine. We hand control over when `done` resolves
// so the tests can exercise timeout / abort / happy-path separately.
interface FakeRunnerHandle {
  runner: EngineRunner;
  lastOptions: RunnerOptions;
  sentPrompts: string[];
  aborted: boolean;
  resolveDone: (result: EngineResult) => void;
  writeHandoff: (payload: unknown) => Promise<void>;
}

function makeFake(handoffPath: string): { engine: Engine; getHandle: () => FakeRunnerHandle } {
  let handle: FakeRunnerHandle | undefined;
  const engine: Engine = {
    metadata: {
      id: "fake",
      name: "Fake",
      defaultModel: "fake",
      description: "test",
      parity: {
        resumeMode: "local_transcript",
        handoffMode: "generic_file_write",
        progressMode: "builtin_todo",
        toolExecutionMode: "provider_native",
        taskScopeMode: "subagent",
        supportsExternalToolResults: false,
      },
    },
    createRunner(options: RunnerOptions): EngineRunner {
      const { promise, resolve } = Promise.withResolvers<EngineResult>();
      const sentPrompts: string[] = [];
      const state = { aborted: false };
      const runner: EngineRunner = {
        send: (text: string) => sentPrompts.push(text),
        end: () => {},
        abort: () => {
          state.aborted = true;
          resolve({ durationMs: 0, failure: { kind: "aborted" } });
        },
        done: promise,
      };
      handle = {
        runner,
        lastOptions: options,
        sentPrompts,
        get aborted() { return state.aborted; },
        resolveDone: (result: EngineResult) => resolve(result),
        async writeHandoff(payload: unknown): Promise<void> {
          await Bun.write(handoffPath, JSON.stringify(payload));
        },
      };
      return runner;
    },
  };
  return { engine, getHandle: () => handle as FakeRunnerHandle };
}

const SimpleHandoffSchema = z.object({
  summary: z.string(),
  count: z.number(),
}).passthrough();

describe("invokeHandoffRunner — happy path", () => {
  it("returns the validated handoff when the runner resolves successfully", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);

    const promise = invokeHandoffRunner({
      engine,
      model: "test-model",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "do something",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
    });

    const handle = getHandle();
    await handle.writeHandoff({ summary: "done", count: 2 });
    handle.resolveDone({ durationMs: 10 });

    const result = await promise;
    expect(result.summary).toBe("done");
    expect(result.count).toBe(2);
    expect(handle.sentPrompts).toEqual(["do something"]);
  });

  it("passes through engine-runner options (model, effort, systemPrompt, sessionDir, toolActions, cwd, signal)", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);
    const external = new AbortController();

    const promise = invokeHandoffRunner({
      engine,
      model: "claude-sonnet-4-6",
      auth: AUTH,
      cwd: tmpDir,
      sessionDir: tmpDir,
      systemPrompt: "you are X",
      effort: "medium",
      toolActions: ["handoff_write"],
      prompt: "payload",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
      signal: external.signal,
    });

    const handle = getHandle();
    expect(handle.lastOptions.model).toBe("claude-sonnet-4-6");
    expect(handle.lastOptions.systemPrompt).toBe("you are X");
    expect(handle.lastOptions.effort).toBe("medium");
    expect(handle.lastOptions.sessionDir).toBe(tmpDir);
    expect(handle.lastOptions.cwd).toBe(tmpDir);
    expect(handle.lastOptions.toolActions).toEqual(["handoff_write"]);
    expect(handle.lastOptions.handoffPath).toBe(handoffPath);
    expect(handle.lastOptions.signal).toBe(external.signal);

    await handle.writeHandoff({ summary: "ok", count: 1 });
    handle.resolveDone({ durationMs: 1 });
    await promise;
  });

  it("forwards onEvent callback to the runner", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);
    const events: NDJSONEvent[] = [];

    const promise = invokeHandoffRunner({
      engine,
      model: "m",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "x",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
      onEvent: (ev) => events.push(ev),
    });

    const handle = getHandle();
    const event: NDJSONEvent = { type: "text", data: { hello: "world" }, raw: "" };
    handle.lastOptions.onEvent(event);
    await handle.writeHandoff({ summary: "s", count: 0 });
    handle.resolveDone({ durationMs: 1 });
    await promise;

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
  });

  it("clears the runner-timeout handle before returning (no leaked setTimeout from the helper)", async () => {
    // We observe setTimeout calls with ms === LONG_TIMEOUT_MS (our helper's runner timeout)
    // to distinguish the helper's timer from readHandoff's internal timer (5000ms).
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);

    const LONG_TIMEOUT_MS = 60_000;
    type TimerId = ReturnType<typeof setTimeout>;
    let helperTimerId: TimerId | undefined;
    let helperTimerCleared = false;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const patchedSetTimeout = ((fn: () => void, ms?: number): TimerId => {
      const id = origSetTimeout(fn, ms);
      if (ms === LONG_TIMEOUT_MS) helperTimerId = id;
      return id;
    }) as typeof setTimeout;
    const patchedClearTimeout = ((id: TimerId): void => {
      if (id === helperTimerId) helperTimerCleared = true;
      origClearTimeout(id);
    }) as typeof clearTimeout;
    globalThis.setTimeout = patchedSetTimeout;
    globalThis.clearTimeout = patchedClearTimeout;

    try {
      const promise = invokeHandoffRunner({
        engine,
        model: "m",
        auth: AUTH,
        cwd: tmpDir,
        prompt: "x",
        handoffPath,
        handoffSchema: SimpleHandoffSchema,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      const handle = getHandle();
      await handle.writeHandoff({ summary: "s", count: 0 });
      handle.resolveDone({ durationMs: 1 });
      await promise;

      expect(helperTimerId).toBeDefined();
      expect(helperTimerCleared).toBe(true);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });
});

describe("invokeHandoffRunner — timeout", () => {
  it("aborts the runner and rejects with a timeout-shaped error", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);

    const promise = invokeHandoffRunner({
      engine,
      model: "m",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "x",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
      timeoutMs: 15,
    });

    await expect(promise).rejects.toMatchObject({ name: "HandoffRunnerTimeoutError" });
    expect(getHandle().aborted).toBe(true);
  });
});

describe("invokeHandoffRunner — external abort", () => {
  it("aborts the runner and rejects with an abort-shaped error distinct from timeout", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);
    const external = new AbortController();

    const promise = invokeHandoffRunner({
      engine,
      model: "m",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "x",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
      timeoutMs: 60_000,
      signal: external.signal,
    });

    setTimeout(() => external.abort(), 10);

    try {
      await promise;
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("HandoffRunnerAbortedError");
      expect((err as Error).name).not.toBe("HandoffRunnerTimeoutError");
    }
    expect(getHandle().aborted).toBe(true);
  });
});

describe("invokeHandoffRunner — schema validation failure", () => {
  it("throws HandoffInvalidError when the handoff file fails schema validation", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);

    const promise = invokeHandoffRunner({
      engine,
      model: "m",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "x",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
    });

    const handle = getHandle();
    await handle.writeHandoff({ not_summary: "nope" });
    handle.resolveDone({ durationMs: 1 });

    await expect(promise).rejects.toBeInstanceOf(HandoffInvalidError);
  });
});

describe("invokeHandoffRunner — missing handoff", () => {
  it("throws HandoffMissingError when the handoff file does not exist", async () => {
    const handoffPath = join(tmpDir, "handoff.json");
    const { engine, getHandle } = makeFake(handoffPath);

    const promise = invokeHandoffRunner({
      engine,
      model: "m",
      auth: AUTH,
      cwd: tmpDir,
      prompt: "x",
      handoffPath,
      handoffSchema: SimpleHandoffSchema,
    });

    getHandle().resolveDone({ durationMs: 1 });

    await expect(promise).rejects.toBeInstanceOf(HandoffMissingError);
  });
});
