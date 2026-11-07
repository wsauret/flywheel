/** The bash tool's own behavior over injected operations and a probe for the
 *  owned-process seam: validation, live output, compression, the scratchpad
 *  shim, and the foreground spool. The integration tier runs the real shell. */

import { beforeAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { FileReadLedger } from "../../../../../src/orchestration/agent-runtime/tools/file-read-ledger.js";
import { canonicalMutationPath } from "../../../../../src/infra/file-mutation-queue.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { executeDispatchedTool } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { makeMockOps, makeMockOwnedProcess, ownedSpawnProbe, streamOf } from "./_bash-fixtures.js";
import { makeContext } from "./_fixtures.js";
import { createPrivateCopyPool } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-pool.js";

/** The search path of an environment, under the name it keeps: Windows spells it `Path`. */
const pathOf = (env: { readonly [name: string]: string | undefined }) => Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1];

beforeAll(async () => {
  await loadBashParser();
});

/** A call as the dispatcher runs it: the tool's execution policy, then its execution. */
const dispatch = (def: RuntimeTool, input: RuntimeToolInput, context: ToolContext) => Effect.runPromise(executeDispatchedTool({
  prepared: prepareToolCall({ id: "call-1", name: def.name, input }, new Map([[def.name, def]]), { ok: true }),
  context,
  gate: createToolConcurrencyGate(1),
}));

describe("bash tool: file reads count as reads", () => {
  const directory = temporaryDirectories();
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

  async function ledgerAfter(command: string, exitCode = 0): Promise<{ root: string; ledger: FileReadLedger }> {
    const root = path.join(directory("bash-file-reads-"), "project");
    fs.mkdirSync(root);
    for (const [name, count] of [["a.ts", 3], ["b.ts", 5], ["c.ts", 5], ["d.ts", 3], ["big.ts", 4_000]] as const) fs.writeFileSync(path.join(root, name), lines(count));
    fs.writeFileSync(path.join(root, "..", "outside.ts"), lines(3));
    const ledger = new FileReadLedger();
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ exited: Promise.resolve({ code: exitCode, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }) }));
    await createBashDefinition({ operations: makeMockOps() }).execute({ command }, makeContext({ executionCwd: root, projectRoot: root, spawnOwned: spawn.spawnOwned, readLedger: ledger }));
    return { root, ledger };
  }

  function staleness(root: string, ledger: FileReadLedger, name: string, changed?: { start: number; end: number }) {
    const file = canonicalMutationPath(path.join(root, name));
    return ledger.staleness(file, fs.readFileSync(file), changed);
  }

  it("records the lines that a successful cat, nl, head, tail, or sed -n printed", async () => {
    const { root, ledger } = await ledgerAfter("cat -n a.ts && sed -n '2,3p' b.ts; head -n 2 c.ts && tail -1 c.ts && echo done");
    expect(staleness(root, ledger, "a.ts", { start: 1, end: 3 })).toBeUndefined();
    expect(staleness(root, ledger, "b.ts", { start: 2, end: 3 })).toBeUndefined();
    expect(staleness(root, ledger, "b.ts", { start: 4, end: 4 })).toEqual({ kind: "uncovered", lines: { start: 4, end: 4 } });
    expect(staleness(root, ledger, "c.ts", { start: 5, end: 5 })).toBeUndefined();
    expect(staleness(root, ledger, "c.ts", { start: 3, end: 3 })).toEqual({ kind: "uncovered", lines: { start: 3, end: 3 } });
  });

  it("records nothing for a failed command, shell syntax beyond plain reads, a file outside the project, or output compression would shorten", async () => {
    for (const [command, exitCode] of [
      ["cat a.ts", 1],
      ["cat a.ts | grep line", 0],
      ["cat a.ts > d.ts", 0],
      ["rm -f d.ts && cat a.ts", 0],
      ["cat a.ts d.ts", 0],
      ["cat *.ts", 0],
      ["sed -i -n '1p' a.ts", 0],
      ["cat \"$(echo a.ts)\"", 0],
      ["cat ../outside.ts", 0],
      ["cat big.ts", 0],
    ] as const) {
      const { root, ledger } = await ledgerAfter(command, exitCode);
      const unread = { kind: "unread" } as const;
      expect({ command, a: staleness(root, ledger, "a.ts"), big: staleness(root, ledger, "big.ts"), outside: staleness(root, ledger, "../outside.ts") }).toEqual({ command, a: unread, big: unread, outside: unread });
    }
  });
});

describe("bash tool: mock operations (DI surface)", () => {
  it("launches through the injected owned-process seam and the injected script operations", async () => {
    const writeCalls: { path: string; content: string }[] = [];
    const deleteCalls: string[] = [];
    const spawn = ownedSpawnProbe();

    const def = createBashDefinition({ operations: makeMockOps({
      async writeScript(p, content) {
        writeCalls.push({ path: p, content });
        return content.length;
      },
      async deleteScript(p) {
        deleteCalls.push(p);
      },
    }) });
    const ctx = makeContext({ executionCwd: "/mock/cwd", spawnOwned: spawn.spawnOwned });
    const result = await def.execute({ command: "echo hello" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("mock output");
    expect(result.content).toContain("[exit code: 0]");
    expect(spawn.launches.length).toBe(1);
    expect(spawn.launches[0]!.cwd).toBe("/mock/cwd");
    expect(spawn.launches[0]!.stdin).toBe("ignore");
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0]!.path.startsWith(os.tmpdir())).toBe(true);
    expect(deleteCalls.length).toBe(1);
    const home = await def.execute({ command: "echo hello", cwd: "~" }, ctx);
    expect(home.outcome).toBe("ok");
    expect(String(home.content)).toStartWith("[Path '~' was expanded to '");
    expect(spawn.launches.at(-1)?.cwd).toBe(os.homedir());
  });

  it("still validates interactive commands with mock operations", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned });

    const result = await dispatch(def, { command: "vim file.txt" }, ctx);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Interactive command detected");
  });

  it("runs a file inspection command as written and returns only its output", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const spawn = ownedSpawnProbe();
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: spawn.spawnOwned, availableTools: new Set(["read", "bash"]), handoff: { onContent() {} } });
    const result = await def.execute({ command: "cat a.txt" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(spawn.launches.length).toBe(1);
    expect(result.content).toContain("mock output");
    expect(result.content).not.toContain("Reminder:");
  });

  it("reports non-zero exit codes from mock subprocess as data, not tool error", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }),
      stdout: streamOf("error: something failed\n"),
    }));
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: spawn.spawnOwned });
    const result = await def.execute({ command: "failing-command" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.details).toMatchObject({ exitCode: 1 });
    expect(result.content).toContain("error: something failed");
    expect(result.content).toContain("[exit code: 1]");
  });

  it("validates command parameter type", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned });
    const result = await def.execute({ command: 42 }, ctx);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("without a 'command' string");
  });
});

describe("bash tool: live execution output", () => {
  const runStdout = (
    stdout: ReadableStream<Uint8Array>,
    onExecutionOutput?: (text: string) => void,
    executionOutputThrottleMs = 0,
  ) => {
    const def = createBashDefinition({
      operations: makeMockOps(),
      executionOutputThrottleMs,
    });
    const spawnOwned = ownedSpawnProbe(() => makeMockOwnedProcess({ stdout })).spawnOwned;
    const ctx = onExecutionOutput
      ? makeContext({ executionCwd: "/mock", spawnOwned, onExecutionOutput })
      : makeContext({ executionCwd: "/mock", spawnOwned });
    return def.execute({ command: "echo streamed" }, ctx);
  };

  it("keeps final content equal for single and multi-chunk stdout", async () => {
    const single = await runStdout(streamOf("alpha\nbeta\n"));
    const multi = await runStdout(streamOf(["alpha\n", "beta\n"]));

    expect(multi.outcome).toBe(single.outcome);
    expect(multi.content).toBe(single.content);
  });

  it("captures a sanitized execution tail bounded to 1000 lines", async () => {
    const stdout = Array.from({ length: 1001 }, (_, index) => `line-${index}`).join("\n");
    const result = await runStdout(streamOf(`\u001b[31m${stdout}\u001b[0m\u0000`));
    const tail = result.executionOutputTail ?? "";

    expect(tail.split("\n")).toHaveLength(1000);
    expect(tail.startsWith("line-1\n")).toBe(true);
    expect(tail.endsWith("line-1000")).toBe(true);
    expect(tail).not.toContain("\u001b");
    expect(tail).not.toContain("\u0000");
  });

  it("captures at most 256KiB of sanitized execution output", async () => {
    const result = await runStdout(streamOf("x".repeat(300 * 1024)));
    const tail = result.executionOutputTail ?? "";

    expect(new TextEncoder().encode(tail).byteLength).toBe(256 * 1024);
    expect(tail).toBe("x".repeat(256 * 1024));
  });

  it("keeps a trailing newline when line-bounding the execution tail", async () => {
    const stdout = Array.from({ length: 1500 }, (_, index) => `line-${index + 1}\n`).join("");
    const result = await runStdout(streamOf(stdout));
    const tail = result.executionOutputTail ?? "";

    const lines = tail.split("\n");
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe("line-501");
    expect(lines.at(-2)).toBe("line-1500");
  });

  it("drops a lone surrogate when the byte bound splits an astral pair", async () => {
    // Sized so the smallest suffix within 256KiB starts on the low surrogate
    // of an emoji: rest = "x" + 65535 emoji = 262141 bytes; lone low
    // surrogate encodes as 3 bytes, landing exactly on the bound, while the
    // full emoji overshoots. The skip must drop the lone surrogate.
    const content = ["y".repeat(10), "\u{1F600}", "x", "\u{1F600}".repeat(65535)].join("");
    const result = await runStdout(streamOf(content));
    const tail = result.executionOutputTail ?? "";

    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(tail.startsWith("x")).toBe(true);
    expect(tail).not.toContain("\uFFFD");
  });

  it("omits the execution tail entirely for empty output", async () => {
    const result = await runStdout(streamOf(""));

    expect("executionOutputTail" in result).toBe(false);
  });

  it("decodes split multi-byte UTF-8 sequences", async () => {
    const bytes = new TextEncoder().encode("a🙂b\n");
    const result = await runStdout(streamOf([bytes.slice(0, 3), bytes.slice(3)]));

    expect(result.content).toContain("a🙂b");
    expect(result.content).not.toContain("�");
  });

  it("emits monotonically growing accumulated output", async () => {
    const emitted: string[] = [];

    await runStdout(streamOf(["a", "b", "c"]), (text) => emitted.push(text));

    expect(emitted).toEqual(["a", "ab", "abc"]);
  });

  it("does not expose control payloads that begin before the live-tail window", async () => {
    const emitted: string[] = [];
    const control = `safe\u001bP${"forged".repeat(10_000)}\u001b\\tail`;

    await runStdout(streamOf([control.slice(0, 40_000), control.slice(40_000)]), (text) => emitted.push(text));

    expect(emitted.at(-1)).toBe("safetail");
    expect(emitted.at(-1)?.length).toBeLessThanOrEqual(50 * 1024);
  });

  it("throttles chunk emissions and flushes the trailing output", async () => {
    const emitted: string[] = [];

    // The window must be one no CI scheduling lag can cross between the
    // synchronous chunk reads; the trailing flush fires at stream end, not on
    // the timer, so a large window does not slow the test.
    await runStdout(streamOf(["a", "b", "c"]), (text) => emitted.push(text), 60_000);

    expect(emitted).toEqual(["a", "abc"]);
  });

  it("does not emit after aborting", async () => {
    const controller = new AbortController();
    const emitted: string[] = [];
    const def = createBashDefinition({
      operations: makeMockOps(),
      executionOutputThrottleMs: 0,
    });

    const result = await def.execute({ command: "echo abort" }, makeContext({
      executionCwd: "/mock",
      spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ stdout: streamOf(["before\n", "after\n"]) })).spawnOwned,
      signal: controller.signal,
      onExecutionOutput: (text) => {
        emitted.push(text);
        controller.abort();
      },
    }));

    expect(result.outcome).toBe("interrupted");
    expect(result.content).not.toContain("before\n");
    expect(result.content).not.toContain("after\n");
    expect(emitted).toEqual(["before\n"]);
  });

  it("runs when the live output callback is omitted", async () => {
    const result = await runStdout(streamOf(["without ", "callback\n"]));

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("without callback");
  });
});

describe("bash tool: timeout bounds", () => {
  const mockContext = () => makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned });

  it("reads millisecond timeouts and caps oversized seconds without dropping the deadline", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    let timeout: number | undefined;
    const ctx = makeContext({ shell: {
      runForeground: async options => { timeout = options.timeoutSec; return { content: "done", outcome: "ok" }; },
      runBackground: async () => { throw new Error("unexpected background"); },
      privateCopies: createPrivateCopyPool(),
      hasActiveCommands: () => false,
    } });
    for (const [requested, seconds, note] of [
      [5400, 3600, "Note: timeout was capped at 3600 seconds."],
      [120000, 120, "Note: timeout 120000 was read as milliseconds: 120 seconds."],
      [100000, 100, "Note: timeout 100000 was read as milliseconds: 100 seconds."],
      [10000, 10, "Note: timeout 10000 was read as milliseconds: 10 seconds."],
      [10001, 10.001, "Note: timeout 10001 was read as milliseconds: 10.001 seconds."],
      [4000000, 3600, "Note: timeout 4000000 was read as milliseconds: 4000 seconds; capped at 3600 seconds."],
    ] as const) {
      const result = await def.execute({ command: "echo hi", timeout: requested }, ctx);
      expect(result.outcome).toBe("ok");
      expect(result.content).toBe(`${note}\ndone`);
      expect(timeout).toBe(seconds);
    }
  });

  it("allows timeout at or below 3600s", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = mockContext();
    const result = await def.execute({ command: "echo hi", timeout: 3600 }, ctx);
    expect(result.outcome).toBe("ok");
  });

  it("works without explicit timeout", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = mockContext();
    const result = await def.execute({ command: "echo hi" }, ctx);
    expect(result.outcome).toBe("ok");
  });

  it("rejects a non-positive timeout (would fire the kill timer immediately)", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const result = await def.execute({ command: "echo hi", timeout: 0 }, mockContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("timeout must be greater than 0");
  });
});

describe("bash tool: interactive-command detection false-positives", () => {
  const runCommand = (command: string) => {
    const def = createBashDefinition({ operations: makeMockOps() });
    return dispatch(def, { command }, makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned }));
  };

  it("does not false-trigger on vi.fn in an inline script", async () => {
    const result = await runCommand("echo 'const x = vi.fn()'");
    expect(result.outcome).toBe("ok");
  });

  it("does not false-trigger on vitest identifier", async () => {
    const result = await runCommand("echo 'from vitest'");
    expect(result.outcome).toBe("ok");
  });

  it("does not false-trigger on words containing ed", async () => {
    const result = await runCommand("echo edited needed");
    expect(result.outcome).toBe("ok");
  });

  it("does not false-trigger on less/more substrings", async () => {
    const result = await runCommand("echo blessed moremoney");
    expect(result.outcome).toBe("ok");
  });
});

describe("bash tool: command policy (via tool)", () => {
  const runCommand = (command: string, availableTools: ReadonlySet<string>) => {
    const def = createBashDefinition({ operations: makeMockOps() });
    return dispatch(def, { command }, makeContext({ executionCwd: "/scratch", projectRoot: "/scratch", availableTools, spawnOwned: ownedSpawnProbe().spawnOwned }));
  };

  it("does not intercept inline scripts, even ones doing file I/O", async () => {
    const inline = await runCommand(
      "node -e 'require(\"fs\").writeFileSync(\"/tmp/x\", \"hi\")'",
      new Set(["edit", "write"]),
    );
    expect(inline.outcome).toBe("ok");
    expect(inline.content).not.toContain("Reminder");

    const script = await runCommand("bun scratch.ts", new Set(["edit", "write"]));
    expect(script.outcome).toBe("ok");
    expect(script.content).not.toContain("Reminder");
  });

  it("runs in-place shell mutation of project files without interception, whatever the tools", async () => {
    for (const tools of [new Set(["bash"]), new Set(["bash", "edit"])]) {
      const result = await runCommand("perl -0pi -e 's/return a - b;/return a + b;/' src/math.ts", tools);
      expect(result.outcome).toBe("ok");
      expect(result.content).not.toContain("Reminder");
      expect(result.content).not.toContain("blocked");
    }
  });

  it("refuses a read-only agent's project and outside writes before launch, and runs its scratch write", async () => {
    const def = createBashDefinition({ operations: makeMockOps(), readOnly: true });
    const spawn = ownedSpawnProbe();
    const ctx = makeContext({ executionCwd: "/proj", projectRoot: "/proj", scratchDir: "/proj/.flywheel/scratch", availableTools: new Set(["read", "bash"]), spawnOwned: spawn.spawnOwned });

    const patch = await dispatch(def, {
      command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/math.ts\n@@\n-return a + b;\n+return a - b;\n*** End Patch\nPATCH",
    }, ctx);
    expect(patch.outcome).toBe("error");
    expect(patch.content).toContain("This agent is read-only");
    expect(patch.content).toContain("src/math.ts");
    const mutation = await dispatch(def, { command: "bun run format", mutates: true }, ctx);
    expect(mutation.outcome).toBe("error");
    expect(mutation.content).toContain("read-only");
    expect(spawn.launches).toHaveLength(0);
    const writer = createBashDefinition({ operations: makeMockOps() });
    expect(def.inputSchema).toEqual(writer.inputSchema);
    expect(def.description).toBe(writer.description);

    const temporary = await dispatch(def, { command: "cat > /elsewhere/probe.ts <<'EOF'\nconsole.log(1)\nEOF" }, ctx);
    expect(temporary.outcome).toBe("error");
    expect(spawn.launches).toHaveLength(0);
    const scratch = await dispatch(def, { command: "cat > .flywheel/scratch/probe.ts <<'EOF'\nx\nEOF" }, ctx);
    expect(scratch.outcome).toBe("ok");
  });

  it("with the write guard off, refuses a writing agent no target, and keeps a read-only agent's scratchpad rule", async () => {
    const outside = "cat > /elsewhere/probe.ts <<'EOF'\nconsole.log(1)\nEOF";
    const unplaceable = "rm -rf \"$(cat dirs.txt)\"";
    const run = async (options: { readonly readOnly?: boolean; readonly writeGuard?: boolean }, command: string) => {
      const spawn = ownedSpawnProbe();
      const ctx = makeContext({ executionCwd: "/proj", projectRoot: "/proj", scratchDir: "/proj/.flywheel/scratch", availableTools: new Set(["read", "bash"]), spawnOwned: spawn.spawnOwned });
      const result = await dispatch(createBashDefinition({ operations: makeMockOps(), ...options }), { command }, ctx);
      return { outcome: result.outcome, launched: spawn.launches.length > 0 };
    };

    for (const command of [outside, unplaceable]) {
      expect({ command, ...await run({}, command) }).toEqual({ command, outcome: "error", launched: false });
      expect({ command, ...await run({ writeGuard: false }, command) }).toEqual({ command, outcome: "ok", launched: true });
      expect({ command, ...await run({ readOnly: true, writeGuard: false }, command) }).toEqual({ command, outcome: "error", launched: false });
    }
    expect(await run({ readOnly: true, writeGuard: false }, "cat > .flywheel/scratch/probe.ts <<'EOF'\nx\nEOF")).toEqual({ outcome: "ok", launched: true });
  });

  it("offers a headless runtime no mutating declaration, so a command that edits project files runs in place", async () => {
    const edit = "perl -0pi -e 's/a/b/' src/math.ts";
    const run = async (mutatingDeclaration: boolean, input: RuntimeToolInput) => {
      const spawn = ownedSpawnProbe();
      const ctx = makeContext({ executionCwd: "/proj", projectRoot: "/proj", scratchDir: "/proj/.flywheel/scratch", spawnOwned: spawn.spawnOwned });
      const result = await dispatch(createBashDefinition({ operations: makeMockOps(), mutatingDeclaration }), input, ctx);
      return { outcome: result.outcome, content: String(result.content), cwds: spawn.launches.map((launch) => launch.cwd) };
    };
    const declared = await run(false, { command: edit, mutates: true });
    expect(declared.outcome).toBe("error");
    expect(declared.content).toContain("unexpected parameter `mutates`");
    expect(declared.cwds).toEqual([]);
    const inPlace = await run(false, { command: edit });
    expect(inPlace.outcome).toBe("ok");
    expect(inPlace.cwds).toEqual(["/proj"]);
    // An interactive runtime takes the same declaration to its private-copy route.
    expect((await run(true, { command: edit, mutates: true })).content).toContain("mutation Git wrapper");
  });

  it("does not intercept bun -e without file I/O", async () => {
    const result = await runCommand(
      "bun -e 'console.log(1 + 1)'",
      new Set(["edit", "write"]),
    );
    expect(result.outcome).toBe("ok");
  });

  it("blocks sleeps longer than 30 seconds outright", async () => {
    const result = await runCommand("sleep 240; tail -5 build.log", new Set(["bash"]));
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("sleeping longer than 30s");
  });
});

describe("bash tool: scratchpad and bun shim", () => {
  const scratchDir = "/proj/.flywheel/sessions/s1/scratch";
  // A login shell PATH that holds no search program, so no search shim joins
  // these cases; tools-bash-environment.test.ts owns the search shims.
  const loginShellPath = "/scratch/without-search-programs";

  const makeRecordingDef = (execPath: string, platform?: NodeJS.Platform) => {
    const dirs: string[] = [];
    const shims: { path: string; content: string }[] = [];
    const spawn = ownedSpawnProbe();
    const def = createBashDefinition({
      execPath,
      ...(platform ? { platform } : {}),
      loginShellPath: () => loginShellPath,
      operations: makeMockOps({
        ensureDir: (p) => { dirs.push(p); },
        writeExecutable: async (p, content) => { shims.push({ path: p, content }); },
      }),
    });
    return { def, dirs, shims, launches: spawn.launches, spawnOwned: spawn.spawnOwned };
  };

  it("installs the BUN_BE_BUN shim once in binary mode and prepends its bin dir to PATH", async () => {
    const { def, dirs, shims, launches, spawnOwned } = makeRecordingDef("/opt/flywheel/flywheel", "linux");
    const ctx = makeContext({ executionCwd: "/mock", scratchDir, spawnOwned });

    const result = await def.execute({ command: "bun scratch.ts" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(dirs).toEqual([scratchDir, path.join(scratchDir, "bin")]);
    expect(shims).toHaveLength(1);
    expect(shims[0]!.path).toBe(path.join(scratchDir, "bin", "bun"));
    expect(shims[0]!.content).toContain('BUN_BE_BUN=1 "/opt/flywheel/flywheel"');
    expect(launches[0]!.env!.PATH!.startsWith(path.join(scratchDir, "bin"))).toBe(true);

    // Second call reuses the prepared scratchpad: no re-write, same PATH prefix.
    await def.execute({ command: "bun scratch.ts" }, ctx);
    expect(shims).toHaveLength(1);
    expect(launches[1]!.env!.PATH!.startsWith(path.join(scratchDir, "bin"))).toBe(true);
  });

  it("writes a bun.cmd shim on Windows", async () => {
    const { def, shims, spawnOwned } = makeRecordingDef("C:\\flywheel\\flywheel.exe", "win32");

    await def.execute({ command: "echo hi" }, makeContext({ executionCwd: "/mock", scratchDir, spawnOwned }));

    expect(shims).toHaveLength(1);
    expect(shims[0]!.path.endsWith("bun.cmd")).toBe(true);
    expect(shims[0]!.content).toContain("set BUN_BE_BUN=1");
    expect(shims[0]!.content).toContain('"C:\\flywheel\\flywheel.exe" %*');
  });

  it("installs the shim exactly once under concurrent first calls", async () => {
    let writes = 0;
    const def = createBashDefinition({
      execPath: "/opt/flywheel/flywheel",
      loginShellPath: () => loginShellPath,
      operations: makeMockOps({
        writeExecutable: async () => {
          writes++;
          await Bun.sleep(5);
        },
      }),
    });
    const ctx = makeContext({ executionCwd: "/mock", scratchDir, spawnOwned: ownedSpawnProbe().spawnOwned });

    await Promise.all([
      def.execute({ command: "echo a" }, ctx),
      def.execute({ command: "echo b" }, ctx),
    ]);

    expect(writes).toBe(1);
  });

  it("skips the shim when running through bun but still creates the scratch dir", async () => {
    const { def, dirs, shims, launches, spawnOwned } = makeRecordingDef("/usr/local/bin/bun");
    const ctx = makeContext({ executionCwd: "/mock", scratchDir, spawnOwned });

    const result = await def.execute({ command: "echo hi" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(dirs).toEqual([scratchDir]);
    expect(shims).toHaveLength(0);
    // No shim, so PATH carries no scratchpad prefix. The full-environment
    // contract belongs to tools-bash-environment.test.ts.
    expect(pathOf(launches[0]!.env!)).toBe(loginShellPath);
  });

  it("prepares no scratchpad when none is configured", async () => {
    const { def, dirs, shims, launches, spawnOwned } = makeRecordingDef("/opt/flywheel/flywheel");

    const result = await def.execute({ command: "echo hi" }, makeContext({ executionCwd: "/mock", spawnOwned }));

    expect(result.outcome).toBe("ok");
    expect(dirs).toEqual([]);
    expect(shims).toHaveLength(0);
    expect(pathOf(launches[0]!.env!)).toBe(loginShellPath);
  });
});

describe("bash tool: fullContent on compression", () => {
  const spawnWithStdout = (stdout: ReadableStream<Uint8Array>): NonNullable<ToolContext["spawnOwned"]> =>
    ownedSpawnProbe(() => makeMockOwnedProcess({ stdout })).spawnOwned;

  it("sets fullContent to raw output when compressor drops lines", async () => {
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const stdout = streamOf([lines.slice(0, 1_000), lines.slice(1_000)]);
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/scratch", spawnOwned: spawnWithStdout(stdout) });

    const result = await def.execute({ command: "ls -la" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("lines omitted");
    expect(result.fullContent).toBe(lines);
  });

  it("does not set fullContent when output is short enough to skip compression", async () => {
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/scratch", spawnOwned: spawnWithStdout(streamOf("hello\nworld\n")) });

    const result = await def.execute({ command: "echo hi" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.fullContent).toBeUndefined();
  });

  it("raw_output: true bypasses compression entirely", async () => {
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const def = createBashDefinition({ operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/scratch", spawnOwned: spawnWithStdout(streamOf(lines)) });

    const result = await def.execute({ command: "ls -la", raw_output: true }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.content).not.toContain("lines omitted");
    expect(result.content).toContain("line 2000\n");
    expect(result.fullContent).toBeUndefined();
  });
});

describe("bash tool: foreground stdout spool", () => {
  it("bounds multi-megabyte output, names the retained spool with its measured size and digest, and sanitizes split control strings", async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bash-spool-"));
    try {
      const lines = Array.from({ length: 200_000 }, (_, index) => `${index + 1}`).join("\n");
      const payload = `\u001bP${"forged".repeat(1_000)}\u001b\\${lines}\n`;
      const stdout = streamOf([payload.slice(0, 3_000), payload.slice(3_000, 700_000), payload.slice(700_000)]);
      const def = createBashDefinition({ operations: makeMockOps({ ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }) }) });
      const ctx = makeContext({ scratchDir, executionCwd: "/scratch", spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ stdout })).spawnOwned });

      const result = await def.execute({ command: "produce output" }, ctx);
      if (typeof result.content !== "string") throw new Error("bash returns text content");
      const retained = result.retainedFullContent;
      if (!retained) throw new Error("expected the retained spool");
      const spool = fs.readFileSync(retained.path);

      expect(result.content).toStartWith("1\n2\n");
      // The head keeps 6,000 bytes (lines 1-1422), and the tail keeps the last 12,000 and the line that crosses into them.
      expect(result.content).toContain("\n1422\n[... 196863 lines omitted ...]\n198286\n");
      expect(result.content).not.toContain("forged");
      expect(retained.path.startsWith(scratchDir)).toBe(true);
      expect(retained.bytes).toBe(new TextEncoder().encode(payload).byteLength);
      expect(retained.bytes).toBe(spool.byteLength);
      expect(retained.sha256).toBe(new Bun.CryptoHasher("sha256").update(spool).digest("hex"));
      if (process.platform !== "win32") expect(fs.statSync(retained.path).mode & 0o777).toBe(0o600);
      expect(result.fullContent).toBeUndefined();
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("removes a small foreground spool after exact output is read", async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bash-spool-"));
    try {
      const def = createBashDefinition({ operations: makeMockOps({ ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }) }) });
      const ctx = makeContext({ scratchDir, executionCwd: "/scratch", spawnOwned: ownedSpawnProbe(() => makeMockOwnedProcess({ stdout: streamOf("small output\n") })).spawnOwned });

      const result = await def.execute({ command: "produce output", raw_output: true }, ctx);

      expect(result.content).toContain("small output");
      expect(fs.readdirSync(scratchDir).filter((name) => name.includes("foreground") || name.endsWith(".log"))).toEqual([]);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("bash tool: managed foreground transfer backing", () => {
  it("requires both registry and controller backing before launching real Bash", async () => {
    const bash = createBashDefinition({ requireManagedExecution: true });
    await expect(bash.execute({ command: "echo no" }, makeContext())).rejects.toThrow(
      "Foreground Bash requires a session-owned background execution registry and hold controller",
    );
  });
});
