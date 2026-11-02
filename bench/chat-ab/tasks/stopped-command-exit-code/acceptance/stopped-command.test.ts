import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import type { BackgroundCommandRecord } from "../src/infra/runtime-fact-types.js";
import type { BackgroundWorkRow } from "../src/protocol/background-index-protocol-types.js";
import { backgroundRowDetail } from "../src/protocol/client/background-index.js";
import { createBackgroundWorkRegistry } from "../src/orchestration/agent-runtime/background-work.js";
import { startManagedCommand } from "../src/orchestration/agent-runtime/tools/managed-command.js";
import { temporaryDirectories } from "../tests/helpers/directories.js";
import { makeMockOwnedProcess, type OwnedExit } from "../tests/unit/orchestration/agent-runtime/tools/_bash-fixtures.js";

const temporaryDirectory = temporaryDirectories();

function recordingRegistry() {
  const records: BackgroundCommandRecord[] = [];
  const notes: string[] = [];
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => notes.push(text), onCommandRecorded: (record) => { records.push(record); } });
  return { registry, records, notes };
}

function startCommand(registry: ReturnType<typeof createBackgroundWorkRegistry>, toolUseId: string, owned: ReturnType<typeof makeMockOwnedProcess>) {
  return startManagedCommand({
    source: { owned }, processId: `bash-${toolUseId}`, description: "tail -f /dev/null", logPath: join(temporaryDirectory("fw-stopped-command-"), "command.log"),
    startedAtMs: 1_000, identity: { toolUseId }, registry, executionOutputThrottleMs: 0, postExitDrainGraceMs: 0,
  });
}

describe("a background command that a signal ends", () => {
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
    const command = startCommand(registry, "toolu_stop", owned);
    await command.track();

    expect(registry.terminate("toolu_stop")).toBe(true);
    const result = await command.done;
    await Bun.sleep(5);

    const settled = records.at(-1);
    expect(settled).toMatchObject({ toolUseId: "toolu_stop", state: "settled", status: "stopped" });
    expect(settled !== undefined && "exitCode" in settled).toBe(false);
    expect(result.content).toContain("SIGTERM");
    expect(result.content).not.toContain("code unknown");
    expect(result.content).not.toMatch(/code 1\b/);
  });

  it("records a command that a signal ends on its own as failed, with no made-up exit code", async () => {
    const { registry, records } = recordingRegistry();
    const exit = Promise.withResolvers<OwnedExit>();
    const owned = makeMockOwnedProcess({ stderr: undefined, exited: exit.promise });
    const command = startCommand(registry, "toolu_killed", owned);
    await command.track();

    exit.resolve({ code: null, signal: "SIGKILL", statusOf: "payload", ownership: "surrendered" });
    const result = await command.done;
    await Bun.sleep(5);

    const settled = records.at(-1);
    expect(settled).toMatchObject({ toolUseId: "toolu_killed", state: "settled", status: "failed" });
    expect(settled !== undefined && "exitCode" in settled).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.content).toContain("SIGKILL");
    expect(result.content).not.toContain("code unknown");
  });

  it("still records the exit code of a command that exits by itself", async () => {
    const { registry, records } = recordingRegistry();
    const exit = Promise.withResolvers<OwnedExit>();
    const owned = makeMockOwnedProcess({ stderr: undefined, exited: exit.promise });
    const command = startCommand(registry, "toolu_exit", owned);
    await command.track();

    exit.resolve({ code: 2, signal: null, statusOf: "payload", ownership: "surrendered" });
    const result = await command.done;
    await Bun.sleep(5);

    expect(records.at(-1)).toMatchObject({ toolUseId: "toolu_exit", state: "settled", status: "failed", exitCode: 2 });
    expect(result.content).toContain("exited with code 2");
  });
});

const row = (fields: Partial<BackgroundWorkRow> & Pick<BackgroundWorkRow, "id" | "status">): BackgroundWorkRow => ({
  kind: "command", title: fields.id, startedAtMs: 0, cardToolUseId: fields.id, ...fields,
});

describe("background index row detail", () => {
  it("shows the exit code of a command that ended by itself", () => {
    expect(backgroundRowDetail(row({ id: "test", status: "failed", exitCode: 2, durationMs: 1_500 }))).toBe("Failed · exit 2 · 1.5s");
  });

  it("shows a stopped or canceled command with its status and duration, never an exit code", () => {
    // A command that traps the stop signal still exits with a code, and Windows termination always exits 1: neither is the command's outcome.
    expect(backgroundRowDetail(row({ id: "dev", status: "stopped", exitCode: 1, durationMs: 195_000 }))).toBe("Stopped · 3m 15s");
    expect(backgroundRowDetail(row({ id: "build", status: "cancelled", exitCode: 143, durationMs: 1_500 }))).toBe("Canceled · 1.5s");
  });
});
