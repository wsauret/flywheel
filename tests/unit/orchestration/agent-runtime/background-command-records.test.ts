import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { BackgroundCommandRecord } from "../../../../src/infra/runtime-fact-types.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js";
import { startManagedCommand } from "../../../../src/orchestration/agent-runtime/tools/managed-command.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { makeMockOwnedProcess, type OwnedExit } from "./tools/_bash-fixtures.js";

const temporaryDirectory = temporaryDirectories();

describe("createBackgroundWorkRegistry (background index records)", () => {
  it("retries a recovered command's rejected output write and deduplicates only after acknowledgement", async () => {
    let write = Promise.withResolvers<void>();
    let attempts = 0;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
      onExecutionOutputRecorded: () => { attempts++; return write.promise; },
    });
    const meta = { id: "recovered", type: "background_command", description: "build", toolUseId: "tool-recovered" };
    const result: BackgroundWorkResult = { status: "completed", content: "done", executionOutputTail: "final tail\n" };
    const timing = { startedAtMs: 1, settledAtMs: 2 };
    const failed = Promise.resolve(registry.recordSettlement(meta, result, timing));
    write.reject(new Error("output write refused"));
    await expect(failed).rejects.toThrow("output write refused");

    write = Promise.withResolvers<void>();
    const retry = registry.recordSettlement(meta, result, timing);
    expect(attempts).toBe(2);
    write.resolve();
    await retry;
    await registry.recordSettlement(meta, result, timing);
    expect(attempts).toBe(2);
  });

  function recordingRegistry() {
    const records: BackgroundCommandRecord[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {}, onCommandRecorded: (record) => { records.push(record); } });
    return { registry, records };
  }

  it("records a command as running when it starts and with its outcome, exit code, and settle time when it ends", async () => {
    const { registry, records } = recordingRegistry();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: done.promise,
      meta: { id: "bash-bg-1", type: "background_command", description: "bun test", toolUseId: "toolu_bg", modelRequestId: "req-1" },
      startedAtMs: 1_000,
    });
    expect(records).toEqual([{ toolUseId: "toolu_bg", processId: "bash-bg-1", description: "bun test", startedAtMs: 1_000, modelRequestId: "req-1", state: "running" }]);

    const before = Date.now();
    done.resolve({ status: "failed", content: "exited with code 2", exit: { code: 2 } });
    await Bun.sleep(5);

    expect(records[1]).toMatchObject({ toolUseId: "toolu_bg", startedAtMs: 1_000, state: "settled", status: "failed", exitCode: 2 });
    expect(records[1]?.state === "settled" ? records[1].settledAtMs : 0).toBeGreaterThanOrEqual(before);
  });

  it("records a person's Stop as stopped and an agent's as cancelled", async () => {
    const { registry, records } = recordingRegistry();
    const byPerson = Promise.withResolvers<BackgroundWorkResult>();
    const byAgent = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: byPerson.promise, meta: { id: "p", type: "background_command", description: "server", toolUseId: "toolu_p" }, kill: { run: () => {} } });
    registry.track({ done: byAgent.promise, meta: { id: "a", type: "benchmark", description: "bench", toolUseId: "toolu_a" }, kill: { run: () => {} } });

    registry.terminate("toolu_p");
    registry.terminateProcess("a", "agent");
    byPerson.resolve({ status: "failed", content: "terminated", exit: { code: 143 } });
    byAgent.resolve({ status: "failed", content: "terminated" });
    await Bun.sleep(5);

    expect(records.filter((record) => record.state === "settled").map((record) => [record.toolUseId, record.state === "settled" ? record.status : undefined])).toEqual([["toolu_p", "stopped"], ["toolu_a", "cancelled"]]);
  });

  it("records a command that a person stops by a signal as stopped, with no exit code, and names the signal to the model", async () => {
    const { registry, records } = recordingRegistry();
    const exit = Promise.withResolvers<OwnedExit>();
    const owned = makeMockOwnedProcess({
      stderr: undefined,
      exited: exit.promise,
      terminate: async () => {
        const ended: OwnedExit = { code: null, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(ended);
        return ended;
      },
    });
    const command = startManagedCommand({
      source: { owned }, processId: "bash-bg-stop", description: "tail -f /dev/null", logPath: join(temporaryDirectory("fw-stopped-command-"), "stop.log"),
      startedAtMs: 1_000, identity: { toolUseId: "toolu_stop" }, registry, executionOutputThrottleMs: 0, postExitDrainGraceMs: 0,
    });
    await command.track();

    expect(registry.terminate("toolu_stop")).toBe(true);
    const result = await command.done;
    await Bun.sleep(5);

    const settled = records.at(-1);
    expect(settled).toMatchObject({ toolUseId: "toolu_stop", state: "settled", status: "stopped" });
    expect(settled !== undefined && "exitCode" in settled).toBe(false);
    expect(result.content).toContain("ended by signal SIGTERM");
    expect(result.content).not.toContain("exit code");
  });

  it("records the outcome of a command the host tears down and publishes its completion", async () => {
    const notes: string[] = [];
    const records: BackgroundCommandRecord[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notes.push(text), onCommandRecorded: (record) => { records.push(record); } });
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: done.promise, meta: { id: "bg", type: "background_command", description: "server", toolUseId: "toolu_bg" }, kill: { run: () => { done.resolve({ status: "failed", content: "killed", exit: { code: 143 } }); } } });

    await registry.terminateAll();

    expect(notes).toEqual([expect.stringContaining("<status>failed</status>")]);
    expect(notes[0]).toContain("killed");
    expect(records.at(-1)).toMatchObject({ toolUseId: "toolu_bg", state: "settled", status: "failed", exitCode: 143 });
  });

  it("records a settled command before it announces the change, so no index read finds it running with no owner", async () => {
    const records: BackgroundCommandRecord[] = [];
    const statesAtChange: string[][] = [];
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
      onCommandRecorded: (record) => { records.push(record); },
      onChange: () => { statesAtChange.push(records.map((record) => record.state)); },
    });
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: done.promise, meta: { id: "bg", type: "background_command", description: "build", toolUseId: "toolu_bg" }, kill: { run: () => {} } });
    done.resolve({ status: "completed", content: "done", exit: { code: 0 } });
    await Bun.sleep(5);

    expect(statesAtChange).toEqual([["running"], ["running", "settled"]]);
  });

  it("leaves a command whose exit no one recorded at running, so the index reads it as ended", async () => {
    const { registry, records } = recordingRegistry();
    const observed = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: observed.promise, meta: { id: "adopted", type: "background_command", description: "dev server", toolUseId: "toolu_adopted" }, startedAtMs: 1_000 });
    observed.resolve({ status: "failed", content: "ended with the previous runtime" });
    registry.recordSettlement({ id: "settled-elsewhere", type: "background_command", description: "build", toolUseId: "toolu_elsewhere" }, { status: "failed", content: "its supervisor kept no outcome" }, { startedAtMs: 1_000, settledAtMs: 9_000_000 });
    await Bun.sleep(5);

    expect(records.map((record) => [record.toolUseId, record.state])).toEqual([["toolu_adopted", "running"]]);
  });

  it("records no subagent, no command without a tool call, and nothing for a command it handed over", async () => {
    const { registry, records } = recordingRegistry();
    const handed = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), meta: { id: "sub", type: "subagent", description: "worker", toolUseId: "toolu_sub" } });
    registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), meta: { id: "bare", type: "background_command", description: "no call" } });
    registry.track({ done: handed.promise, meta: { id: "handed", type: "background_command", description: "dev server", toolUseId: "toolu_handed" } });

    registry.detach("handed");
    handed.resolve({ status: "completed", content: "ended elsewhere", exit: { code: 0 } });
    await Bun.sleep(5);

    expect(records.map((record) => [record.toolUseId, record.state])).toEqual([["toolu_handed", "running"]]);
  });
});
