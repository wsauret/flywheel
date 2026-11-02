import { describe, expect, it } from "bun:test";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createShellRuntime } from "../../../../../src/orchestration/agent-runtime/tools/shell-runtime.js";
import { createProcessorClaims, sharedProcessorClaims } from "../../../../../src/orchestration/agent-runtime/tools/processor-claims.js";
import { startManagedCommand } from "../../../../../src/orchestration/agent-runtime/tools/managed-command.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { bridgeExternalPromise } from "../../../../../src/orchestration/agent-runtime/external-promise-bridge.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeMockOps, makeMockOwnedProcess, type OwnedExit } from "./_bash-fixtures.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

// The runtime spools command output under its temporary directory.
const temporaryDirectory = temporaryDirectories();
const EXITED: OwnedExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" };

function shellOptions(sessionId: string, spawnOwned: NonNullable<ToolContext["spawnOwned"]>) {
  return {
    command: "held command",
    context: { executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: `child-${sessionId}`, retrievalSessionId: sessionId, sessionId },
    spawnOwned,
    env: {},
    operations: makeMockOps(),
    platform: "linux" as const,
    tempDir: temporaryDirectory("fw-shell-runtime-"),
    executionOutputThrottleMs: 0,
  };
}

/** Waits until `token` is claimed, which happens once its launch returns. */
async function claimed(claims: ReturnType<typeof createProcessorClaims>, token: string): Promise<void> {
  const has = (): boolean => claims.claims().some((claim) => claim.token === token);
  if (has()) return;
  await new Promise<void>((resolve) => {
    const stop = claims.onClaimsChanged(() => {
      if (!has()) return;
      stop();
      resolve();
    });
  });
}

describe("shell container processor claims", () => {
  it.each(["foreground", "background", "auto-yield", "detach"] as const)("claims a %s container until the owned container settles", async (mode) => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const claims = createProcessorClaims();
    const runtime = createShellRuntime(tasks, { processorClaims: claims });
    const exit = Promise.withResolvers<OwnedExit>();
    const token = `owned:${mode}`;
    const held = Promise.withResolvers<void>();
    const hold = createForegroundBashHoldController((ids) => { if (ids.includes("toolu_held")) held.resolve(); });
    const options = shellOptions("session-a", async () => makeMockOwnedProcess({ token, exited: exit.promise }));
    const context = { ...options.context, toolUseId: "toolu_held" };
    const execution = mode === "foreground"
      ? runtime.client.runForeground({ ...options, context, timeoutSec: 60, rawOutput: false, postExitDrainGraceMs: 10 })
      : runtime.client.runBackground({ ...options, context: { ...context, foregroundBashHold: hold }, foreground: mode !== "background", totalYieldMs: mode === "auto-yield" ? 1 : 30, rawOutput: false });
    try {
      await claimed(claims, token);
      if (mode === "detach") {
        await held.promise;
        expect(hold.release("toolu_held")).toBe(true);
      }
      if (mode !== "foreground") expect((await execution).details).toMatchObject({ background: true });
      expect(claims.claims()).toEqual([{ token, pid: 12345, order: expect.any(Number), exempt: false }]);
      claims.applyHolds([{ token, ahead: 0 }]);
      expect(claims.heldToolCallIds("session-a")).toEqual(["toolu_held"]);
      exit.resolve(EXITED);
      await execution;
      await tasks.terminateAll();
      expect(claims.claims()).toEqual([]);
    } finally {
      exit.resolve(EXITED);
      await execution;
      await tasks.terminateAll();
      await runtime.close();
      hold.dispose();
    }
  });

  it("exempts only the containers of an owner whose commands a chat's own turn runs", async () => {
    const launch = async (processorExempt: boolean | undefined, token: string) => {
      const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
      const owner = createBackgroundExecutionOwner(tasks, undefined, processorExempt === undefined ? {} : { processorExempt });
      const exit = Promise.withResolvers<OwnedExit>();
      await owner.shell.runBackground({ ...shellOptions("session-a", async () => makeMockOwnedProcess({ token, exited: exit.promise })), foreground: false, rawOutput: false });
      const claim = sharedProcessorClaims().claims().find((candidate) => candidate.token === token);
      exit.resolve(EXITED);
      await owner.close();
      return claim?.exempt;
    };
    expect(await launch(true, "owned:chat-turn")).toBe(true);
    expect(await launch(undefined, "owned:workflow-agent")).toBe(false);
  });

  it("tells the agent that a held command waits for processor time when it reaches the foreground cap", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const claims = createProcessorClaims();
    const runtime = createShellRuntime(tasks, { processorClaims: claims });
    const exit = Promise.withResolvers<OwnedExit>();
    const options = shellOptions("session-a", async () => makeMockOwnedProcess({ token: "owned:capped", exited: exit.promise }));
    const execution = runtime.client.runBackground({ ...options, context: { ...options.context, toolUseId: "toolu_capped" }, foreground: true, totalYieldMs: 20, rawOutput: false });
    try {
      await claimed(claims, "owned:capped");
      claims.applyHolds([{ token: "owned:capped", ahead: 3 }]);
      expect((await execution).content).toContain("It waits for processor time, with 3 commands ahead of it.");
    } finally {
      exit.resolve(EXITED);
      await execution;
      await tasks.terminateAll();
      await runtime.close();
    }
  });

  it.each(["foreground", "managed"] as const)("does not count held time against a %s command's explicit timeout", async (mode) => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const claims = createProcessorClaims();
    const runtime = createShellRuntime(tasks, { processorClaims: claims });
    const exit = Promise.withResolvers<OwnedExit>();
    let terminations = 0;
    const token = `owned:timeout-${mode}`;
    // The hold lands as the claim does, so the 10 ms deadline cannot pass
    // between the launch and the hold however slow the machine is.
    const holdOnClaim = claims.onClaimsChanged(() => {
      if (claims.claims().some((claim) => claim.token === token)) {
        holdOnClaim();
        claims.applyHolds([{ token, ahead: 0 }]);
      }
    });
    const options = shellOptions("session-a", async () => makeMockOwnedProcess({ token, exited: exit.promise, terminate: async () => { terminations++; exit.resolve({ ...EXITED, code: 143 }); return exit.promise; } }));
    const execution = mode === "foreground"
      ? runtime.client.runForeground({ ...options, timeoutSec: 0.01, rawOutput: false, postExitDrainGraceMs: 0 })
      : runtime.client.runBackground({ ...options, foreground: false, timeoutSec: 0.01, rawOutput: false });
    try {
      await claimed(claims, token);
      await Bun.sleep(25);
      expect(terminations).toBe(0);
      claims.applyHolds([]);
      await Bun.sleep(25);
      expect(terminations).toBe(1);
    } finally {
      exit.resolve(EXITED);
      await execution;
      await tasks.terminateAll();
      await runtime.close();
    }
  });

  it("hands over a deadline moved later by the time the container was held", () => {
    let heldMs = 0;
    const command = startManagedCommand({
      source: { owned: makeMockOwnedProcess({ exited: new Promise(() => {}) }) },
      processId: "process-held", description: "held", logPath: "/scratch/held.log", startedAtMs: 1_000, deadlineAtMs: 61_000,
      heldTime: { heldMs: () => heldMs, hold: () => undefined, released: () => Promise.resolve() },
      identity: {}, executionOutputThrottleMs: 0, postExitDrainGraceMs: 0,
    });
    try {
      expect(command.deadlineAtMs).toBe(61_000);
      heldMs = 4_000;
      expect(command.deadlineAtMs).toBe(65_000);
    } finally {
      command.release();
    }
  });

  it.each(["caller", "runtime", "owner"] as const)("launches nothing after a %s abort", async (source) => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const caller = new AbortController();
    const owner = new AbortController();
    const claims = createProcessorClaims();
    const runtime = createShellRuntime(tasks, { signal: owner.signal, processorClaims: claims });
    let spawns = 0;
    const options = shellOptions("session-a", async () => { spawns++; return makeMockOwnedProcess(); });
    const prepared = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const execution = runtime.client.runBackground({
      ...options,
      context: { ...options.context, signal: caller.signal },
      operations: makeMockOps({ writeScript: async () => { prepared.resolve(); await proceed.promise; return 0; } }),
      foreground: false,
      rawOutput: false,
    });
    await prepared.promise;
    let closing: Promise<void> | undefined;
    if (source === "runtime") closing = runtime.close();
    else if (source === "owner") owner.abort();
    else caller.abort();
    proceed.resolve();
    try {
      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      expect(spawns).toBe(0);
      expect(claims.claims()).toEqual([]);
      expect(tasks.processRecords()).toEqual([]);
    } finally {
      await closing;
      await runtime.close();
    }
  });

  it("cancels a dispatch that has not launched before owner close waits for its fibers", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const owner = createBackgroundExecutionOwner(tasks);
    const prepared = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    let spawns = 0;
    let interrupted = false;
    const options = shellOptions("session-a", async () => { spawns++; return makeMockOwnedProcess(); });
    const dispatch = owner.run(() => bridgeExternalPromise(async () => {
      try {
        await owner.shell.runBackground({ ...options, foreground: false, rawOutput: false, operations: makeMockOps({ writeScript: async () => { prepared.resolve(); await proceed.promise; return 0; } }) });
      } catch (error) {
        interrupted = error instanceof DOMException && error.name === "AbortError";
      }
    }).owned);
    expect(dispatch).not.toBeNull();
    await prepared.promise;
    const closing = owner.close();
    proceed.resolve();
    await closing;
    expect(interrupted).toBe(true);
    expect(spawns).toBe(0);
  });
});
