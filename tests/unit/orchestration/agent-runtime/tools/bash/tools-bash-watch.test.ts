import { afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBackgroundWorkRegistry } from "../../../../../../src/orchestration/agent-runtime/background-work/background-work.js";
import { loadBashParser } from "../../../../../../src/orchestration/agent-runtime/tools/bash/policy/bash-parser.js";
import { createBashDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/bash/bash.js";
import { bashToolSurface } from "../../../../../../src/orchestration/agent-runtime/tools/bash/bash-guidance.js";
import { startManagedCommand } from "../../../../../../src/orchestration/agent-runtime/tools/bash/execution/managed-command.js";
import type { BackgroundCommandRecord } from "../../../../../../src/infra/substrate/runtime-facts/runtime-fact-types.js";
import { asRecord } from "../../../../../../src/infra/guards/record.js";
import { watchNoticeRow } from "../../../../../../src/infra/substrate/events/watch-notices.js";
import { WATCH_LIMITS } from "../../../../../../src/orchestration/agent-runtime/tools/bash/execution/watch-stream.js";
import { backgroundLogPath } from "../../../../../helpers/background-log-path.js";
import { bashExecution, makeMockOps, makeMockOwnedProcess, ownedSpawnProbe, type OwnedExit } from "./_bash-fixtures.js";
import { capabilityAccessHolding, makeContext } from "../_fixtures.js";

beforeAll(async () => {
  await loadBashParser();
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
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

interface Delivered { readonly text: string; readonly key: string | undefined }

/** One watch launched through the bash tool, with a log the test writes and a
 *  container the test ends. */
async function launchWatch(input: { readonly timeout?: number; readonly holds?: () => boolean; readonly command?: string } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-watch-"));
  directories.push(directory);
  const delivered: Delivered[] = [];
  const records: BackgroundCommandRecord[] = [];
  const registry = createBackgroundWorkRegistry({
    kind: "chat",
    enqueueNotification: (text, key) => { delivered.push({ text, key }); },
    onCommandRecorded: (record) => { records.push(record); },
    ...(input.holds ? { holdsWatchEvents: input.holds } : {}),
  });
  const exit = deferred<OwnedExit>();
  let logPath = "";
  const def = createBashDefinition({
    ...bashExecution(registry),
    tmpDir: directory,
    executionOutputThrottleMs: 10,
    postExitDrainGraceMs: 0,
    operations: makeMockOps({
      writeScript: async (_scriptPath, content) => {
        logPath = backgroundLogPath(content) ?? "";
        await Bun.write(logPath, "");
        return content.length;
      },
    }),
  });
  const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
    pid: 4242,
    exited: exit.promise,
    terminate: async () => {
      const settled: OwnedExit = { code: null, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
      exit.resolve(settled);
      return settled;
    },
  }));
  const result = await def.execute(
    { command: input.command ?? "tail -f app.log | grep --line-buffered ERROR", watch: true, ...(input.timeout === undefined ? {} : { timeout: input.timeout }) },
    makeContext({ capabilityAccess: capabilityAccessHolding(["background-commands"]), executionCwd: directory, toolUseId: "toolu_watch", spawnOwned: spawn.spawnOwned }),
  );
  const processId = registry.processRecords()[0]?.id ?? "";
  const write = (text: string): void => { fs.appendFileSync(logPath, text); };
  return { registry, delivered, records, result, processId, write, exit, spawn, events: () => delivered.filter(({ key }) => key?.endsWith(":end") === false && key.startsWith("watch:")) };
}

describe("bash watch", () => {
  it("delivers each batch of complete lines as an event under the key of its end position, only to its own registry, and ends with how it ended", async () => {
    const other: string[] = [];
    createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { other.push(text); } });
    const watch = await launchWatch();
    expect(watch.result.outcome).toBe("ok");
    expect(watch.result.content).toContain(`watch ${watch.processId}`);
    expect(watch.records[0]).toMatchObject({ state: "running", watch: true });

    watch.write("ERROR one <tag>\nERROR two\n");
    await waitUntil(() => watch.events().length === 1);
    const first = watch.events()[0]!;
    expect(first.key).toBe(`watch:${watch.processId}:26`);
    expect(first.text).toContain("<watch_event>");
    expect(first.text).toContain("ERROR one &lt;tag&gt;");
    expect(watchNoticeRow([first.key!], first.text)?.text).toBe("ERROR one <tag>\nERROR two");

    watch.write("ERROR three\nunfinished");
    await waitUntil(() => watch.events().length === 2);
    expect(watch.events()[1]?.key).toBe(`watch:${watch.processId}:38`);

    watch.write(" tail\nlast complete\npartial");
    await Bun.sleep(5);
    watch.exit.resolve({ code: 3, signal: null, statusOf: "payload", ownership: "surrendered" });
    await waitUntil(() => watch.delivered.some(({ key }) => key === `watch:${watch.processId}:end`));
    const end = watch.delivered.find(({ key }) => key === `watch:${watch.processId}:end`)!;
    const row = watchNoticeRow([end.key!], end.text);
    expect(row?.text.split("\n")[0]).toMatch(/^The watched command exited with code 3 after .+\. It delivered \d events\.$/);
    expect(row?.text).toContain("partial");
    expect(other).toEqual([]);
  });

  it("reads nothing while its owner holds events, and continues from the same place afterwards", async () => {
    let held = true;
    const watch = await launchWatch({ holds: () => held });
    watch.write("ERROR during hold\n");
    await Bun.sleep(300);
    expect(watch.events()).toEqual([]);
    held = false;
    await waitUntil(() => watch.events().length === 1);
    expect(watch.events()[0]?.key).toBe(`watch:${watch.processId}:18`);
    expect(watch.events()[0]?.text).toContain("ERROR during hold");
    watch.registry.terminate("toolu_watch");
    await waitUntil(() => watch.delivered.some(({ key }) => key?.endsWith(":end") === true));
  });

  it("ends a hold at the deadline and names where the output that reached no event starts", async () => {
    const watch = await launchWatch({ timeout: 0.1, holds: () => true });
    watch.write("ERROR during hold\n");
    await waitUntil(() => watch.delivered.some(({ key }) => key?.endsWith(":end") === true));
    expect(watch.events()).toEqual([]);
    expect(watch.registry.processRecords()[0]?.status).not.toBe("running");
    const end = watch.delivered.at(-1)!;
    expect(watchNoticeRow([end.key!], end.text)?.text).toMatch(/^The watch reached its 0s deadline after .+ and was stopped\. It delivered 0 events\. The output after byte 0 of the log reached no event; read it at log_path\.$/);
  });

  it("keeps the lines of a watch that ends during a hold for events after it, in batches of at most 3,000 characters, before its last notice", async () => {
    let held = true;
    const watch = await launchWatch({ holds: () => held });
    const lines = Array.from({ length: 60 }, (_, index) => `ERROR ${String(index).padStart(2, "0")} ${"x".repeat(90)}`);
    watch.write(`${lines.join("\n")}\nunfinished`);
    watch.exit.resolve({ code: 1, signal: null, statusOf: "payload", ownership: "surrendered" });
    await Bun.sleep(100);
    expect(watch.delivered).toEqual([]);
    held = false;
    await waitUntil(() => watch.delivered.some(({ key }) => key?.endsWith(":end") === true));
    const texts = watch.events().map(({ key, text }) => watchNoticeRow([key!], text)?.text ?? "");
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((text) => text.length <= 3_000)).toBe(true);
    expect(texts.join("\n")).toBe(lines.join("\n"));
    const end = watch.delivered.at(-1)!;
    expect(watchNoticeRow([end.key!], end.text)?.text).toBe(`The watched command exited with code 1 after ${/after (.+)\. It/.exec(end.text)?.[1]}. It delivered ${texts.length} events.\nunfinished`);
  });

  it("names the deadline, five minutes by default, and a stop by a person as the way it ended", async () => {
    const defaulted = await launchWatch();
    const command = defaulted.registry.processCommand(defaulted.processId);
    expect((command?.deadlineAtMs ?? 0) - (command?.startedAtMs ?? 0)).toBe(300_000);
    defaulted.registry.terminate("toolu_watch");
    await waitUntil(() => defaulted.delivered.some(({ key }) => key?.endsWith(":end") === true));
    // The person's Stop is stated inside the watch's notice, so its row survives.
    const stopped = defaulted.delivered.at(-1)!;
    expect(stopped.text).toStartWith("<watch_ended>");
    expect(stopped.text).toContain("Do not redo the stopped work.");
    expect(watchNoticeRow([stopped.key!], stopped.text)).toEqual({
      watch: { processId: defaulted.processId, description: "tail -f app.log | grep --line-buffered ERROR", kind: "end" },
      text: expect.stringMatching(/^The watch was stopped by the person after .+\. It delivered 0 events\.$/),
    });

    // Lines that a stop leaves in an open batch reach no event, and the
    // notice says where they start.
    const batched = await launchWatch();
    batched.write("ERROR first\n");
    await waitUntil(() => batched.events().length === 1);
    batched.write("ERROR just before stop\n");
    await Bun.sleep(40);
    batched.registry.terminate("toolu_watch");
    await waitUntil(() => batched.delivered.some(({ key }) => key?.endsWith(":end") === true));
    expect(batched.events()).toHaveLength(1);
    const batchedEnd = batched.delivered.at(-1)!;
    expect(watchNoticeRow([batchedEnd.key!], batchedEnd.text)?.text).toMatch(/^The watch was stopped by the person after .+\. It delivered 1 event\. The output after byte 12 of the log reached no event; read it at log_path\.$/);

    const expiring = await launchWatch({ timeout: 0.05 });
    expiring.write("unfinished at the deadline");
    await waitUntil(() => expiring.delivered.some(({ key }) => key?.endsWith(":end") === true));
    const row = watchNoticeRow([expiring.delivered.at(-1)!.key!], expiring.delivered.at(-1)!.text);
    expect(row?.text).toMatch(/^The watch reached its 0s deadline after .+ and was stopped\. It delivered 0 events\.\nunfinished at the deadline$/);
  });

  it("refuses a watch in the foreground or with persist_after_exit", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const context = makeContext({ capabilityAccess: capabilityAccessHolding(["background-commands"]) });
    for (const input of [{ background: false }, { persist_after_exit: true }]) {
      const result = await def.execute({ command: "tail -f log", watch: true, ...input }, context);
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("watch=true");
    }
  });
});

describe("watch ending", () => {
  it("stops a source that stays over the rate limit for more than 30 seconds and names too much output and the delivered count in its last row", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-watch-noisy-"));
    directories.push(directory);
    const logPath = path.join(directory, "watch.log");
    fs.writeFileSync(logPath, "");
    const delivered: Delivered[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => { delivered.push({ text, key }); } });
    const exit = deferred<OwnedExit>();
    const command = startManagedCommand({
      source: { owned: makeMockOwnedProcess({ exited: exit.promise, terminate: async () => {
        const settled: OwnedExit = { code: null, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" };
        exit.resolve(settled);
        return settled;
      } }) },
      processId: "bash-bg-noisy",
      description: "yes ERROR",
      logPath,
      startedAtMs: Date.now(),
      identity: { toolUseId: "toolu_noisy" },
      registry,
      executionOutputThrottleMs: 5,
      postExitDrainGraceMs: 0,
      watch: { position: 0, events: 0 },
    });
    await command.track();
    const end = (): Delivered | undefined => delivered.find(({ key }) => key === "watch:bash-bg-noisy:end");
    // The watch reads the clock through Date.now, so the test moves it 250 ms
    // for each line: one event every 250 ms is over the limit of one every 2 s.
    let now = Date.now();
    try {
      for (let line = 0; line < 400 && end() === undefined; line += 1) {
        fs.appendFileSync(logPath, `ERROR ${line}\n`);
        now += 250;
        setSystemTime(new Date(now));
        await Bun.sleep(15);
      }
    } finally {
      setSystemTime();
    }
    const last = end();
    expect(last).toBeDefined();
    const events = delivered.filter(({ key }) => key !== "watch:bash-bg-noisy:end");
    expect(events.length).toBeGreaterThanOrEqual(10);
    expect(events.some(({ text }) => text.includes("<dropped_events>"))).toBe(true);
    const row = watchNoticeRow([last!.key!], last!.text);
    expect(row?.watch.kind).toBe("end");
    expect(row?.text).toMatch(new RegExp(`^The watch was stopped because the command wrote too much output: \\d+ events dropped over 3\\ds\\. It delivered ${events.length} events\\.`));
  });
});

describe("watch handover", () => {
  it("lets a successor continue from the place the predecessor handed over, with no line repeated or lost", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-watch-handover-"));
    directories.push(directory);
    const logPath = path.join(directory, "watch.log");
    fs.writeFileSync(logPath, "");
    const delivered: Delivered[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => { delivered.push({ text, key }); } });
    const exit = deferred<OwnedExit>();
    const start = (watch: { position: number; events: number }) => startManagedCommand({
      source: { owned: makeMockOwnedProcess({ exited: exit.promise }) },
      processId: "bash-bg-handover",
      description: "watch",
      logPath,
      startedAtMs: Date.now(),
      identity: { toolUseId: "toolu_handover" },
      registry,
      executionOutputThrottleMs: 10,
      postExitDrainGraceMs: 0,
      watch,
    });
    const predecessor = start({ position: 0, events: 0 });
    await predecessor.track();
    fs.appendFileSync(logPath, "a1\na2\n");
    await waitUntil(() => delivered.length === 1);
    // Read but not yet sent when the handover comes: the successor reads it again.
    fs.appendFileSync(logPath, "b1\n");
    await Bun.sleep(30);
    const place = predecessor.watchForHandover();
    expect(place).toMatchObject({ position: 6, events: 1, limiter: expect.objectContaining({ tokens: WATCH_LIMITS.burst - 1 }) });
    predecessor.release();

    const successor = start(place!);
    await successor.track();
    fs.appendFileSync(logPath, "c1\n");
    await waitUntil(() => delivered.length === 2);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    await waitUntil(() => delivered.length === 3);

    const texts = delivered.slice(0, 2).map(({ key, text }) => watchNoticeRow([key!], text)?.text);
    expect(texts).toEqual(["a1\na2", "b1\nc1"]);
    expect(delivered.map(({ key }) => key)).toEqual(["watch:bash-bg-handover:6", "watch:bash-bg-handover:12", "watch:bash-bg-handover:end"]);
    expect(watchNoticeRow([delivered[2]!.key!], delivered[2]!.text)?.text).toContain("It delivered 2 events.");
  });
});

describe("watch guidance", () => {
  it("states each rule of a watch in the guidance an agent reads, and exempts a watch's filter from the output rule", () => {
    const surface = bashToolSurface();
    const watchGuidance = asRecord(asRecord(surface.inputSchema.properties)?.watch)?.description;
    const guidance = [surface.description, ...(surface.promptGuidelines ?? []), typeof watchGuidance === "string" ? watchGuidance : ""].join("\n");
    for (const rule of [
      // Every output line is an event, and the agent filters a noisy stream itself.
      /Every output line is an event, from stdout and stderr alike/,
      /redirect a stream you do not need/,
      /A watch is the exception: its redirects and filtering pipes choose its events/,
      // One notice means an ordinary background run; many mean a watch.
      /Choose a watch when you need to hear about each occurrence/,
      /When one notice is enough, .* run the command in the background without watch/,
      // Flush each pipe stage per line.
      /Each stage of a pipe must pass each line on as soon as it has it/,
      // Match failure states, not only success.
      /Match the failure states as well as success/,
      // Emit only new items in a poll loop.
      /print only the items that are new since the last pass/,
      // Wait until the deadline with the process tool; never poll or sleep.
      /call process with action wait and a soft_timeout of the time left until the deadline\. Never poll the log or sleep\./,
      // The limits are behavior.
      /within 200 ms arrive as one event\. A line is cut at 500 characters and an event at 3,000\. After a burst of 10 events, one event passes every 2 seconds/,
      /more than 30 seconds is stopped/,
      /300 seconds when you omit it, at most 3600/,
    ]) expect(guidance).toMatch(rule);
  });
});
