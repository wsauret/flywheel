import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { implementQualityJudgeInputIdentity, judgeImplementPairs } from "../../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { planPersonaBenchmark, runPersonaBenchmark, type BenchmarkEvent } from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { createPersonaStore as createRunStore } from "../../../src/orchestration/modules/development/benchmark/persona-store.js";
import { parseVariant } from "../../../src/orchestration/modules/development/benchmark/variant.js";
import { runPersonaTask, type PersonaTaskRequest } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { createNativePersonaInvocation } from "../../../src/orchestration/modules/development/benchmark/native-persona-invocation.js";
import { decodeNativePersonaRequest, decodeNativePersonaResult, nativePersonaPath, nativePersonaStartupFailure, writeNativePersonaResult } from "../../../src/orchestration/modules/development/benchmark/native-persona-codec.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { benchmarkDeps as deps, fakeRuntime, verdictJudge } from "./_persona-benchmark-fixtures.js";

const temporaryDirectory = temporaryDirectories();

describe("native persona benchmark service", () => {
  it("puts declared workspace toolchains first, in order, ahead of the inherited candidate PATH", () => {
    const workspace = "/scratch/workspace";
    const path = nativePersonaPath({ workspace, path: [".bench-home/python/bin", ".bench-home/bin"] }, "/usr/bin:/bin");
    expect(path).toBe([resolve(workspace, ".bench-home/python/bin"), resolve(workspace, ".bench-home/bin"), "/usr/bin:/bin"].join(delimiter));
    expect(nativePersonaPath({ workspace, path: [] }, "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  });
  it("routes native implementation cells, preserves grade evidence on resume, and does not judge nonexistent traps", async () => {
    const root = temporaryDirectory("flywheel-persona-native-benchmark-");
    const personasDir = join(root, "src", "workflows", "agents", "personas");
    await mkdir(personasDir, { recursive: true });
    await Bun.write(join(personasDir, "implementer.md"), `---
name: implementer
description: Implements original requests.
role: implementer
tools:
  - read
---
Implement and hand off.
`);
    const catalog = createBenchmarkCatalog(root);
    const taskDir = join(catalog.implementTasksDir, "native");
    await mkdir(taskDir, { recursive: true });
    await Bun.write(join(taskDir, "instruction.txt"), "Original bug report.\r\n");
    const environment = "The source root is src/.\r\n";
    await Bun.write(join(taskDir, "environment.txt"), environment);
    await Bun.write(join(taskDir, "adapter.py"), "# original native adapter");
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({
      kind: "native", id: "native", stratum: "small", family: "python", split: "development",
      instruction: "instruction.txt", environment: "environment.txt", native: { command: ["python3", "adapter.py"], timeoutMs: 3_600_000, path: [".bench-home/python/bin"] },
    }));
    const nativeGrade = '{"passed":0,"failed":1,"total":1,"evidence":{"original.test_bug":"FAIL"}}\n';
    let candidateCalls = 0;
    const commands: string[][] = [];
    const runOwnedCommand: OwnedCommandRunner = async command => {
      commands.push([...command]);
      const output = command.find(argument => argument.startsWith("--output="));
      if (output) await Bun.write(output.slice("--output=".length), "");
      if (command[2] === "grade") await Bun.write(command[6]!, nativeGrade);
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
    };
    const runtime = {
      ...fakeRuntime(options => {
        candidateCalls++;
        expect(options.executionCwd).not.toBe(root);
        // One event the session store would record and one it would not.
        options.onEvent?.({ type: "tool.input.completed", data: { tool_use: { id: "call-1", name: "read", input: { path: "src/bug.py" } } } });
        options.onEvent?.({ type: "model.content.delta", data: { index: 0, delta: { type: "text_delta", text: "partial" } } });
        return { terminal: { kind: "completed" } };
      }),
      runOwnedCommand,
    };
    const events: BenchmarkEvent[] = [];
    const dependencies = {
      ...deps(runtime, root, events),
      createJudge: async () => ({ complete: async () => { throw new Error("one seat and no traps requires no judge calls"); } }),
      nativeInvocation: {
        sourceIdentity: "test-native-v1",
        run: (request: PersonaTaskRequest, path: readonly string[]) => {
          expect(request.workspace).not.toBe(root);
          expect(path).toEqual([".bench-home/python/bin"]);
          return runPersonaTask(runtime, request);
        },
      },
    };
    const plan = await planPersonaBenchmark({ persona: "implementer", variants: [parseVariant("model-a:medium")], repeats: 1, operation: "run" }, catalog);
    const tasks = await catalog.implementTasks();
    const [task] = tasks;
    if (!task || task.kind !== "native") throw new Error("expected native task");
    expect(task.instruction).toBe("Original bug report.\r\n");
    const prompt = `Original bug report.\r\n\n\n## Native environment context\n${environment}`;
    const sends: string[] = [];
    const createAgent = runtime.createAgent;
    runtime.createAgent = options => {
      const agent = createAgent(options);
      return { ...agent, send: (...args) => { sends.push(String(args[0])); return agent.send(...args); } };
    };
    const { nativeInvocation: _nativeInvocation, ...unconfined } = dependencies;
    // A source change refuses a pending native cell before any native setup, which here would fail on isolation instead.
    const pendingCatalog = createBenchmarkCatalog(root, { resultsRoot: join(root, "pending-results") });
    const pending = await planPersonaBenchmark({ persona: "implementer", variants: [parseVariant("model-a:medium")], repeats: 1, operation: "run" }, pendingCatalog);
    await runPersonaBenchmark(pending, { ...dependencies, catalog: pendingCatalog, signal: AbortSignal.abort(), sourceIdentity: "a".repeat(64) });
    const pendingResume = await planPersonaBenchmark({ operation: "resume", resultsDir: pending.resultsDir, variants: [] }, pendingCatalog);
    await expect(runPersonaBenchmark(pendingResume, { ...unconfined, catalog: pendingCatalog, sourceIdentity: "b".repeat(64) }))
      .rejects.toThrow("Flywheel source changed since this campaign started");
    await expect(runPersonaBenchmark(plan, unconfined)).rejects.toThrow(/native isolation/i);
    expect(candidateCalls).toBe(0);
    expect(commands).toEqual([]);
    await runPersonaBenchmark(plan, dependencies);
    const cellEvidence = join(plan.resultsDir, "cells", plan.variants[0]!.id, "native", "0");
    const stamps = await readdir(cellEvidence);
    expect(stamps).toHaveLength(1);
    const transcript = (await Bun.file(join(cellEvidence, stamps[0]!, "transcript.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(transcript).toEqual([{ type: "tool.input.completed", data: { tool_use: { id: "call-1", name: "read", input: { path: "src/bug.py" } } } }]);
    // The persona's task follows the native prompt in the opening turn.
    expect(sends).toHaveLength(1);
    expect(sends[0]).toStartWith(`${prompt}\n\n`);
    const judgePrompts: string[] = [];
    const candidate = {
      task: task.id, repeat: 0, durationMs: 1, summary: "", linesAdded: 1, linesRemoved: 0,
      filesTouched: 1, acceptancePassed: 0, acceptanceFailed: 1, acceptanceTotal: 1,
      accounting: unavailableJudgeAccounting("synthetic candidate"),
    };
    await judgeImplementPairs([
      { ...candidate, variant: "a", diff: "diff a" },
      { ...candidate, variant: "b", diff: "diff b" },
    ], tasks, {
      complete: async (judgePrompt, signal) => {
        judgePrompts.push(judgePrompt);
        return verdictJudge.complete(judgePrompt, signal);
      },
    }, () => false);
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0]).toContain(`## Plan\n${prompt}\n\n## DIFF A`);
    expect(implementQualityJudgeInputIdentity([{ ...task, environment: "changed mapping", prompt: `${task.instruction}\n\n## Native environment context\nchanged mapping` }]))
      .not.toBe(implementQualityJudgeInputIdentity(tasks));
    const store = await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir });
    expect((await store.loadRuns())[0]).toMatchObject({ mode: "implement", acceptanceFailed: 1, nativeGrade });
    expect(await store.loadAttempts()).toEqual([]);
    expect(await store.loadJudgeAttempts()).toEqual([]);
    expect(commands.filter(command => command[2] === "prepare")).toHaveLength(1);
    expect(commands.filter(command => command[2] === "grade")).toHaveLength(1);
    const resume = await planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [] }, catalog);
    await expect(runPersonaBenchmark(resume, {
      ...dependencies,
      nativeInvocation: { ...dependencies.nativeInvocation, sourceIdentity: "test-native-v2" },
    })).rejects.toThrow("identity changed");
    await runPersonaBenchmark(resume, dependencies);
    expect(candidateCalls).toBe(1);
    expect((await store.loadRuns())[0]).toHaveProperty("nativeGrade", nativeGrade);
    const rescore = await planPersonaBenchmark({ operation: "rescore", resultsDir: plan.resultsDir, variants: [] }, catalog);
    await runPersonaBenchmark(rescore, unconfined);
    expect(candidateCalls).toBe(1);
    for (const operation of ["resume", "rescore"] as const) {
      await Bun.write(join(taskDir, "instruction.txt"), "Changed bug report.");
      const changedTask = await planPersonaBenchmark({ operation, resultsDir: plan.resultsDir, variants: [] }, catalog);
      await expect(runPersonaBenchmark(changedTask, unconfined)).rejects.toThrow("identity changed");
      await Bun.write(join(taskDir, "instruction.txt"), "Original bug report.\r\n");
      const original = await planPersonaBenchmark({ operation, resultsDir: plan.resultsDir, variants: [] }, catalog);
      const personaFile = join(personasDir, "implementer.md");
      const guidance = await Bun.file(personaFile).text();
      await Bun.write(personaFile, `${guidance}\nChanged guidance.\n`);
      await expect(runPersonaBenchmark(original, unconfined)).rejects.toThrow("identity changed");
      await Bun.write(personaFile, guidance);
    }
  });
  async function verifyNativeTransport(seat: PersonaTaskRequest["seat"]): Promise<void> {
    const resultsRoot = temporaryDirectory("flywheel-native-transport-");
    const catalog = createBenchmarkCatalog(resolve(import.meta.dir, "../../.."), { resultsRoot });
    const accounting = {
      estimatedUsd: { kind: "observed", value: 0.25 },
      billedUsd: { kind: "observed", value: 0 },
      tokens: { kind: "observed", value: 123 },
      providers: { kind: "observed", value: ["chatgpt"] },
      pricedEntryCount: 1, unpricedEntryCount: 0,
    } as const;
    const reply = { kind: "unsuccessful", terminal: { kind: "timed-out", timeoutMs: 10 }, accounting, durationMs: 42, message: "candidate deadline" } as const;
    expect(() => decodeNativePersonaResult({ ...reply, accounting: { ...accounting, tokens: { kind: "observed", value: -1 } } })).toThrow();
    expect(() => decodeNativePersonaResult({ ...reply, extra: "unexpected" })).toThrow();
    expect(() => decodeNativePersonaResult({ ...reply, terminal: { kind: "timed-out", timeoutMs: -1 } })).toThrow();
    let settled = false;
    let requestPath = "";
    const controller = new AbortController();
    const startupCleared = Promise.withResolvers<void>();
    const settlementStarted = Promise.withResolvers<void>();
    const timerHost: {
      setTimeout: (...args: Parameters<typeof setTimeout>) => ReturnType<typeof setTimeout>;
      clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => void;
    } = globalThis;
    const realSetTimeout = timerHost.setTimeout;
    const realClearTimeout = timerHost.clearTimeout;
    // The invocation checks for signal files every 250 ms; run those checks
    // at once so the test needs no long real timer.
    const pollAtOnce = (delay: number | undefined): number | undefined => delay === 250 ? 1 : delay;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const timers = spyOn(timerHost, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = realSetTimeout(callback, pollAtOnce(delay), ...args);
      if (delay === 180_000) {
        if (startupTimer === undefined) startupTimer = timer;
        else settlementStarted.resolve();
      }
      return timer;
    });
    // Drop every watch event, as macOS does under load: the invocation must
    // still see the readiness signal from the file itself.
    const realWatch = fs.watch;
    const watches = spyOn(fs, "watch").mockImplementation((filename: fs.PathLike) => realWatch(filename));
    const clears = spyOn(timerHost, "clearTimeout").mockImplementation(timer => {
      realClearTimeout(timer);
      if (timer === startupTimer) startupCleared.resolve();
    });
    const runtime = {
      ...fakeRuntime(() => { throw new Error("the parent must not create a native Agent"); }),
      admissionIdentity: { runtimeConfig: "config" },
      runOwnedCommand: (async (command, options) => {
        expect(options?.timeoutMs).toBe(25 * 60_000 + 2 * 180_000);
        requestPath = command[3]!;
        const dto = decodeNativePersonaRequest(JSON.parse(await Bun.file(requestPath).text()));
        expect(dto.prompt).toBe("Original bytes.\r\n");
        expect(dto.path).toEqual([".bench-home/python/bin"]);
        expect(dto.admissionIdentity).toEqual({ runtimeConfig: "config" });
        expect(dto.seat).toEqual(seat.model === undefined ? {} : { model: seat.model, effort: seat.effort });
        expect(dto.usageAuthority).toEqual({ profileId: "persona-test", authorityIncarnation: "persona-test-incarnation" });
        await Bun.write(join(dirname(requestPath), "ready"), "");
        await startupCleared.promise;
        controller.abort();
        while (!await Bun.file(command[5]!).exists()) await Bun.sleep(5);
        await settlementStarted.promise;
        expect(options?.signal?.aborted).toBe(false);
        await writeNativePersonaResult(command[4]!, reply);
        settled = true;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
      }) satisfies OwnedCommandRunner,
    };
    const invoke = await createNativePersonaInvocation(runtime, catalog);
    const request: PersonaTaskRequest = {
      persona: { kind: "persona", name: "implementer", role: "implementer", description: "", systemPrompt: "", tools: ["read"], maxTurns: 1 },
      seat, prompt: "Original bytes.\r\n", label: "cell",
      workspace: resultsRoot,
    };
    const path = [".bench-home/python/bin"];
    try {
      await expect(invoke.run({ ...request, signal: controller.signal }, path)).rejects.toMatchObject({ terminal: reply.terminal, accounting: { accounting, durationMs: 42 } });
    } finally {
      timers.mockRestore();
      watches.mockRestore();
      clears.mockRestore();
    }
    expect(settled).toBe(true);
    expect(await Bun.file(requestPath).exists()).toBe(false);
    const startup = nativePersonaStartupFailure("account", "account-home-changed", 3);
    const failedStartup = await createNativePersonaInvocation({
      ...runtime,
      runOwnedCommand: async command => {
        await writeNativePersonaResult(command[4]!, startup);
        return { exitCode: 1, timedOut: false, stdout: "", stderr: "untrusted credential content", stdoutBytes: new Uint8Array() };
      },
    }, catalog);
    await expect(failedStartup.run(request, path)).rejects.toMatchObject({
      message: "Native startup failed: account/account-home-changed",
      terminal: { kind: "failed", message: "Native startup failed: account/account-home-changed" },
      accounting: { accounting: startup.accounting },
    });
    const missingResult = await createNativePersonaInvocation({
      ...runtime,
      runOwnedCommand: async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "untrusted credential content", stdoutBytes: new Uint8Array() }),
    }, catalog);
    await expect(missingResult.run(request, path)).rejects.toMatchObject({
      terminal: { kind: "failed", message: "Native launcher exited with code 1" },
      accounting: { accounting: { tokens: { kind: "unavailable" } } },
    });
    const grace = Promise.withResolvers<() => void>();
    let scheduled = 0;
    const settlementTimers = spyOn(timerHost, "setTimeout").mockImplementation((callback, delay, ...args) => {
      const timer = realSetTimeout(callback, pollAtOnce(delay), ...args);
      if (delay === 180_000 && ++scheduled === 2) grace.resolve(() => callback(...args));
      return timer;
    });
    const completedThenForced = await createNativePersonaInvocation({
      ...runtime,
      runOwnedCommand: async (command, options) => {
        await writeNativePersonaResult(command[4]!, { kind: "completed", accounting, durationMs: 1, handoff: null, summary: "candidate completed" });
        await Bun.write(join(dirname(command[3]!), "settling"), "");
        (await grace.promise)();
        expect(options?.signal?.aborted).toBe(true);
        return { exitCode: null, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
      },
    }, catalog);
    try {
      await expect(completedThenForced.run(request, path)).rejects.toMatchObject({
        terminal: { kind: "failed", message: "Native settlement deadline exceeded" },
        accounting: { accounting, durationMs: 1 },
      });
    } finally {
      settlementTimers.mockRestore();
    }
  }
  for (const seat of [parseVariant("model-a:high"), {}]) {
    it.if(process.platform === "darwin")(`preserves typed worker settlement and rejects malformed IPC with ${"model" in seat ? "an explicit model" : "profile policy"}`, () => verifyNativeTransport(seat));
  }
});
