import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { configDirFiles, stopQuery } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";

const temporaryDirectory = temporaryDirectories();

/** A query, a process, and the config-directory files, all recording what the
 *  stop procedure does to them in order. */
function stopHarness(options: { readonly interruptSettles: boolean; readonly exitsAfterClose: boolean; readonly lockHeld: (nowMs: number) => boolean }) {
  const events: string[] = [];
  const exit = Promise.withResolvers<undefined>();
  let running = true;
  const query = {
    interrupt: () => { events.push("interrupt"); return options.interruptSettles ? Promise.resolve(undefined) : new Promise<undefined>(() => {}); },
    close: () => {
      events.push("close");
      if (options.exitsAfterClose) { running = false; exit.resolve(undefined); }
    },
  };
  const owned = {
    exited: () => exit.promise,
    running: () => running,
    terminate: async () => { events.push("terminate"); running = false; exit.resolve(undefined); },
  };
  const files = (now: () => number): Parameters<typeof stopQuery>[3] => ({
    refreshLockHeld: () => options.lockHeld(now()),
    removeKilledLeftovers: (sessionId) => { events.push(`remove-leftovers:${sessionId}`); },
  });
  return { events, query, owned, files };
}

async function runStop(harness: ReturnType<typeof stopHarness>, turnActive: boolean, advanceMs: number) {
  return await Effect.runPromise(Effect.gen(function* () {
    let clockMs = 0;
    const fiber = yield* Effect.forkChild(stopQuery(harness.query, harness.owned, "session-1", harness.files(() => clockMs), turnActive));
    for (let elapsed = 0; elapsed < advanceMs; elapsed += 100) {
      yield* Effect.yieldNow;
      clockMs += 100;
      yield* TestClock.adjust(100);
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
}

describe("bridge rule 3: stopping a query", () => {
  test("an idle CLI is closed without an interrupt, and exits on its own", async () => {
    const harness = stopHarness({ interruptSettles: true, exitsAfterClose: true, lockHeld: () => false });
    const stop = await runStop(harness, false, 0);

    expect(harness.events).toEqual(["close"]);
    expect(stop).toEqual({ interrupted: false, lockWaitMs: 0, lockTimedOut: false, terminated: false });
  });

  test("an active turn is interrupted before the close, and an interrupt that hangs gives up at 5 s", async () => {
    const harness = stopHarness({ interruptSettles: false, exitsAfterClose: true, lockHeld: () => false });
    const stop = await runStop(harness, true, 5_100);

    expect(harness.events).toEqual(["interrupt", "close"]);
    expect(stop.interrupted).toBe(false);
  });

  test("the close waits until the token-refresh lock is gone", async () => {
    const harness = stopHarness({ interruptSettles: true, exitsAfterClose: true, lockHeld: (now) => now < 1_000 });
    const stop = await runStop(harness, true, 1_200);

    expect(harness.events).toEqual(["interrupt", "close"]);
    expect(stop).toEqual({ interrupted: true, lockWaitMs: 1_000, lockTimedOut: false, terminated: false });
  });

  test("a lock that outlives 35 s bounds the wait, and a CLI that does not exit is killed and its leftovers removed", async () => {
    const harness = stopHarness({ interruptSettles: true, exitsAfterClose: false, lockHeld: (now) => now < 60_000 });
    const stop = await runStop(harness, false, 40_200);

    expect(harness.events).toEqual(["close", "terminate", "remove-leftovers:session-1"]);
    expect(stop).toEqual({ interrupted: false, lockWaitMs: 35_000, lockTimedOut: true, terminated: true });
  });

  test("a CLI that does not exit after the close is ended at once, because its container's stop waits for the lock itself", async () => {
    const harness = stopHarness({ interruptSettles: true, exitsAfterClose: false, lockHeld: (now) => now >= 4_000 && now < 7_000 });
    const stop = await runStop(harness, false, 5_200);

    expect(harness.events).toEqual(["close", "terminate", "remove-leftovers:session-1"]);
    expect(stop).toEqual({ interrupted: false, lockWaitMs: 0, lockTimedOut: false, terminated: true });
  });

  test("a killed CLI's leftovers are removed, and a running CLI's record and socket under the same session id stay", () => {
    const config = temporaryDirectory("flywheel-sdk-leftovers-");
    const temporary = temporaryDirectory("flywheel-sdk-temporary-");
    const sockets = join(temporary, "cc-socks");
    mkdirSync(join(config, "sessions"));
    mkdirSync(sockets);
    // The highest pid that a signal accepts names no process on any supported platform.
    const killed = 2_147_483_646;
    const leftovers = (pid: number, sessionId: string) => {
      writeFileSync(join(config, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId }));
      writeFileSync(join(sockets, `${pid}.sock`), "");
      return () => [existsSync(join(config, "sessions", `${pid}.json`)), existsSync(join(sockets, `${pid}.sock`))];
    };
    const killedFiles = leftovers(killed, "session-1");
    const runningFiles = leftovers(process.pid, "session-1");
    const otherFiles = leftovers(killed - 1, "session-2");

    configDirFiles({ configDir: config, temporaryDirectory: temporary }).removeKilledLeftovers("session-1");

    expect([killedFiles(), runningFiles(), otherFiles()]).toEqual([[false, false], [true, true], [true, true]]);
  });

  test("the legacy lock is checked beside the resolved config directory, and an unresolvable directory has no lock", () => {
    const root = temporaryDirectory("flywheel-sdk-legacy-lock-");
    const configDir = join(root, "login");
    const alias = join(root, "alias");
    mkdirSync(configDir);
    symlinkSync(configDir, alias, process.platform === "win32" ? "junction" : "dir");
    const files = configDirFiles({ configDir: alias, temporaryDirectory: root });

    expect(files.legacyLockLeft()).toBe(false);
    mkdirSync(`${realpathSync(configDir)}.lock`);
    expect(files.legacyLockLeft()).toBe(true);
    expect(configDirFiles({ configDir: join(root, "missing"), temporaryDirectory: root }).legacyLockLeft()).toBe(false);
  });
});
