import { describe, expect, test } from "bun:test";
import type { FileSink } from "bun";
import type { StopHold } from "../../../../../src/infra/stop-hold.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import type { OwnedProcess, OwnedProcessExit } from "../../../../../src/infra/owned-subprocess.js";
import { ownedClaudeProcess } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/owned-spawn.js";

const EXIT: OwnedProcessExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" };

function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

/** A launcher whose nested scope records each launch and hands out a
 *  container the test releases when it chooses. */
function recordingLauncher(stdout: readonly string[], stderr: readonly string[]) {
  const launches: { command: readonly string[]; cwd?: string; env?: unknown; stopHold?: StopHold }[] = [];
  const written: string[] = [];
  const record = { opened: 0, closed: 0, terminated: 0, stdin: written, launches };
  const exit = Promise.withResolvers<OwnedProcessExit>();
  const container = Promise.withResolvers<OwnedProcess>();
  const stdin: FileSink = {
    write: (chunk) => { record.stdin.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return 0; },
    flush: () => 0,
    end: () => { record.stdin.push("<end>"); return 0; },
    start: () => {},
    ref: () => {},
    unref: () => {},
  };
  const owned: OwnedProcess = {
    pid: 4242, token: "token", stdin, stdout: streamOf(...stdout), stderr: streamOf(...stderr), exited: exit.promise,
    terminate: async () => { record.terminated += 1; exit.resolve({ ...EXIT, code: 143 }); return await exit.promise; },
  };
  const nested: LauncherScope = {
    spawnOwned: (command, options) => {
      record.launches.push({ command, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }), env: options?.env, ...(options?.stopHold === undefined ? {} : { stopHold: options.stopHold }) });
      return container.promise;
    },
    adoptOwned: () => Promise.reject(new Error("no adoption")),
    open: () => nested,
    close: async () => { record.closed += 1; return { settled: true }; },
  };
  const parent: LauncherScope = { ...nested, open: () => { record.opened += 1; return nested; } };
  return { parent, record, ready: () => container.resolve(owned), exit };
}

const REFRESH_HOLD: StopHold = { path: "/config/.oauth_refresh.lock", boundMs: 35_000 };

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
}

describe("the owned CLI spawn seam", () => {
  test("launches the SDK's command in a nested owned scope and bridges stdin, stdout, and stderr lines", async () => {
    const launcher = recordingLauncher(['{"type":"system"}\n'], ["[debug] one\n[deb", "ug] two\n", "tail"]);
    const lines: string[] = [];
    const process = ownedClaudeProcess(launcher.parent, (line) => lines.push(line), REFRESH_HOLD);
    const spawned = process.spawn({ command: "/bin/claude", args: ["--output-format", "stream-json"], cwd: "/work", env: { HOME: "/home/person" }, signal: new AbortController().signal });

    // The SDK writes before the container exists; the seam holds the write.
    spawned.stdin.write("first\n");
    launcher.ready();
    const output = await readAll(spawned.stdout);
    spawned.stdin.end();
    const exit = new Promise((resolve) => spawned.on("exit", (code, signal) => resolve({ code, signal })));
    launcher.exit.resolve(EXIT);

    expect(launcher.record.opened).toBe(1);
    expect(launcher.record.launches).toEqual([{ command: ["/bin/claude", "--output-format", "stream-json"], cwd: "/work", env: { HOME: "/home/person" }, stopHold: REFRESH_HOLD }]);
    expect(output).toBe('{"type":"system"}\n');
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(launcher.record.stdin).toEqual(["first\n", "<end>"]);
    expect(lines).toEqual(["[debug] one", "[debug] two", "tail"]);
    expect(spawned.exitCode).toBe(0);
  });

  test("an HTTP error line arrives whole with its response body, and only a line above one mebibyte is cut", async () => {
    const errorLine = `[ERROR] API error (attempt 1/1): 400 400 {"type":"error","error":{"type":"invalid_request_error","message":"${"x".repeat(5_000)}"}}`;
    const runaway = "y".repeat(1_100_000);
    const launcher = recordingLauncher([], [`${errorLine}\n`, `${runaway}\n`, "tail"]);
    const lines: string[] = [];
    const process = ownedClaudeProcess(launcher.parent, (line) => lines.push(line), REFRESH_HOLD);
    const spawned = process.spawn({ command: "/bin/claude", args: [], env: {}, signal: new AbortController().signal });
    launcher.ready();
    const exit = new Promise((resolve) => spawned.on("exit", resolve));
    launcher.exit.resolve(EXIT);
    await exit;
    await Bun.sleep(0);

    expect(lines).toEqual([errorLine, "y".repeat(1_048_576), "tail"]);
  });

  test("a kill before the container exists ends it through its supervisor once it does", async () => {
    const launcher = recordingLauncher([], []);
    const process = ownedClaudeProcess(launcher.parent, () => {}, REFRESH_HOLD);
    const spawned = process.spawn({ command: "/bin/claude", args: [], env: {}, signal: new AbortController().signal });

    expect(spawned.kill("SIGTERM")).toBe(true);
    launcher.ready();
    const exit = await new Promise((resolve) => spawned.on("exit", (code, signal) => resolve({ code, signal })));

    expect(launcher.record.terminated).toBe(1);
    expect(exit).toEqual({ code: 143, signal: null });
    expect(spawned.killed).toBe(true);
    expect(process.running()).toBe(false);
  });

  test("the SDK's forwarded abort ends the container, and closing the process closes its nested scope", async () => {
    const launcher = recordingLauncher([], []);
    const process = ownedClaudeProcess(launcher.parent, () => {}, REFRESH_HOLD);
    const abort = new AbortController();
    process.spawn({ command: "/bin/claude", args: [], env: {}, signal: abort.signal });
    launcher.ready();

    abort.abort();
    expect(await process.exited()).toMatchObject({ code: 143 });
    await process.close();

    expect(launcher.record.terminated).toBe(1);
    expect(launcher.record.closed).toBe(1);
  });

  test("a container whose payload could not start reads as an engine that cannot start before the SDK sees its exit, and no other exit does", async () => {
    const exits: readonly (readonly [OwnedProcessExit, boolean])[] = [
      [{ ...EXIT, code: 127 }, true],
      [{ ...EXIT, code: 127, statusOf: "supervisor" }, false],
      [{ ...EXIT, code: 1 }, false],
    ];
    for (const [exit, cannotStart] of exits) {
      const launcher = recordingLauncher([], []);
      const process = ownedClaudeProcess(launcher.parent, () => {}, REFRESH_HOLD);
      const spawned = process.spawn({ command: "/bin/claude", args: [], env: {}, signal: new AbortController().signal });
      const seen = new Promise((resolve) => spawned.on("exit", () => resolve(process.cannotStart())));
      launcher.ready();
      launcher.exit.resolve(exit);

      expect(await seen).toBe(cannotStart);
      expect(await process.exited()).toEqual(exit);
    }
  });
});
