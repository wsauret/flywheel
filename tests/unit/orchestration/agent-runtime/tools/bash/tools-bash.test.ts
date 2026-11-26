/** The bash tool's own behavior over injected operations and a probe for the
 *  owned-process seam: validation, managed foreground execution, its output
 *  bounds, the scratchpad shim, and the retained log. The integration tier
 *  runs the real shell. */

import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Parser } from "web-tree-sitter";

import { createBashDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/bash/bash.js";
import { createBackgroundWorkRegistry } from "../../../../../../src/orchestration/session/control/background-work/background-work.js";
import { createForegroundBashHoldController } from "../../../../../../src/orchestration/session/control/background-work/foreground-bash-hold.js";
import { loadBashParser } from "../../../../../../src/orchestration/agent-runtime/tools/bash/policy/bash-parser.js";
import { FileReadLedger } from "../../../../../../src/orchestration/agent-runtime/tools/files/file-read-ledger.js";
import { canonicalMutationPath } from "../../../../../../src/infra/process/locks/file-mutation-queue.js";
import * as treeSitter from "../../../../../../src/infra/parsing/tree-sitter-parser.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import type { RuntimeToolInput } from "../../../../../../src/orchestration/agent-runtime/tools/types.js";
import { bashExecution, commandOutputOps, dispatchTool as dispatch, makeMockOps, makeMockOwnedProcess, ownedSpawnProbe } from "./_bash-fixtures.js";
import { makeContext } from "../_fixtures.js";
import { createPrivateCopyPool } from "../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy-pool.js";

/** The search path of an environment, under the name it keeps: Windows spells it `Path`. */
const pathOf = (env: { readonly [name: string]: string | undefined }) => Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1];

beforeAll(async () => {
  await loadBashParser();
});

describe("bash tool: file reads count as reads", () => {
  const directory = temporaryDirectories();
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

  /** `output` stands for what the command printed; without it the command prints nothing. */
  async function ledgerAfter(command: string, exitCode = 0, output?: (root: string) => string): Promise<{ root: string; ledger: FileReadLedger }> {
    const root = path.join(directory("bash-file-reads-"), "project");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    for (const [name, count] of [["a.ts", 3], ["b.ts", 5], ["c.ts", 5], ["d.ts", 3], ["big.ts", 4_000], ["sub/e.ts", 4]] as const) fs.writeFileSync(path.join(root, name), lines(count));
    fs.writeFileSync(path.join(root, "..", "outside.ts"), lines(3));
    const ledger = new FileReadLedger();
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ exited: Promise.resolve({ code: exitCode, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }) }));
    const operations = output ? commandOutputOps(output(root)) : makeMockOps();
    await dispatch(createBashDefinition({ ...bashExecution(), operations, postExitDrainGraceMs: 0, executionOutputThrottleMs: 0 }), { command }, makeContext({ executionCwd: root, projectRoot: root, spawnOwned: spawn.spawnOwned, readLedger: ledger }));
    return { root, ledger };
  }

  function versionStaleness(root: string, ledger: FileReadLedger, name: string) {
    const file = canonicalMutationPath(path.join(root, name));
    return ledger.versionStaleness(file, fs.readFileSync(file));
  }

  /** `cat -n` output: each line after its number, right-aligned in six columns, and a tab. */
  const numbered = (text: string) => text.replace(/\n$/, "").split("\n").map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n") + "\n";

  afterEach(() => {
    mock.restore();
  });

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
    // The read is inferred from command syntax, so it never authorizes a whole-file replacement.
    const a = canonicalMutationPath(path.join(root, "a.ts"));
    expect(ledger.versionStaleness(a, fs.readFileSync(a))).toBe("unread");
  });

  it("verifies the version of each named file whose whole text the output showed, in any shell form", async () => {
    const show = (root: string, ...names: string[]) => names.map((name) => `===== ${name}\n${numbered(fs.readFileSync(path.join(root, name), "utf8"))}`).join("");
    const loop = await ledgerAfter('for f in a.ts b.ts; do echo "===== $f"; cat -n "$f"; done', 0, (root) => show(root, "a.ts", "b.ts"));
    expect([versionStaleness(loop.root, loop.ledger, "a.ts"), versionStaleness(loop.root, loop.ledger, "b.ts")]).toEqual([undefined, undefined]);
    const glob = await ledgerAfter("cd sub && cat *.ts", 0, (root) => fs.readFileSync(path.join(root, "sub/e.ts"), "utf8"));
    expect(versionStaleness(glob.root, glob.ledger, "sub/e.ts")).toBeUndefined();
    // A file that the command names but whose whole text the output does not show proves no version.
    const partial = await ledgerAfter("for f in a.ts c.ts; do head -n 2 $f; done", 0, () => lines(2) + lines(2));
    expect([versionStaleness(partial.root, partial.ledger, "a.ts"), versionStaleness(partial.root, partial.ledger, "c.ts")]).toEqual(["unread", "unread"]);
    // Output compression drops the middle of a long file, so the model did not see it whole.
    const compressed = await ledgerAfter("cat big.ts", 0, (root) => fs.readFileSync(path.join(root, "big.ts"), "utf8"));
    expect(versionStaleness(compressed.root, compressed.ledger, "big.ts")).toBe("unread");
    // The output proves only the files that the command names.
    const unnamed = await ledgerAfter("echo listing", 0, (root) => fs.readFileSync(path.join(root, "a.ts"), "utf8"));
    expect(versionStaleness(unnamed.root, unnamed.ledger, "a.ts")).toBe("unread");
  });

  it("records a read from the command policy's parse, with no second parse", async () => {
    const parse = spyOn(Parser.prototype, "parse");
    const { root, ledger } = await ledgerAfter("cat a.ts && echo ok");
    expect(parse).toHaveBeenCalledTimes(1);
    expect(staleness(root, ledger, "a.ts", { start: 1, end: 3 })).toBeUndefined();
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
  it("returns a foreground command's output and exit code through managed execution, over the injected seams", async () => {
    const writeCalls: { path: string; content: string }[] = [];
    const deleteCalls: string[] = [];
    const spawn = ownedSpawnProbe();

    const def = createBashDefinition({ ...bashExecution(), operations: commandOutputOps("mock output\n", {
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
    expect(result.details).toMatchObject({ background: false, exitCode: 0 });
    expect(spawn.launches.length).toBe(1);
    expect(spawn.launches[0]!.cwd).toBe("/mock/cwd");
    expect(spawn.launches[0]!.stdin).toBe("ignore");
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0]!.path.startsWith(os.tmpdir())).toBe(true);
    expect(deleteCalls.length).toBe(1);
    const home = await dispatch(def, { command: "echo hello", cwd: "~" }, ctx);
    expect(home.outcome).toBe("ok");
    expect(String(home.content)).toStartWith("[Path '~' was expanded to '");
    expect(spawn.launches.at(-1)?.cwd).toBe(os.homedir());
  });

  it("still validates interactive commands with mock operations", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned });

    const result = await dispatch(def, { command: "vim file.txt" }, ctx);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Interactive command detected");
  });

  it("runs a file inspection command as written and returns only its output", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: commandOutputOps("mock output\n") });
    const spawn = ownedSpawnProbe();
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: spawn.spawnOwned, availableTools: new Set(["read", "bash"]), handoff: { onContent() {} } });
    const result = await def.execute({ command: "cat a.txt" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(spawn.launches.length).toBe(1);
    expect(result.content).toContain("mock output");
    expect(result.content).not.toContain("Reminder:");
  });

  it("reports non-zero exit codes from mock subprocess as data, not tool error", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: commandOutputOps("error: something failed\n") });
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({
      exited: Promise.resolve({ code: 1, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }),
    }));
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: spawn.spawnOwned });
    const result = await def.execute({ command: "failing-command" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.details).toMatchObject({ exitCode: 1 });
    expect(result.content).toContain("error: something failed");
    expect(result.content).toContain("[exit code: 1]");
  });

  it("validates command parameter type", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const ctx = makeContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned });
    const result = await def.execute({ command: 42 }, ctx);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("without a 'command' string");
  });
});

describe("bash tool: execution output bounds", () => {
  const runOutput = (output: string | Uint8Array, onExecutionOutput?: (text: string) => void) => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {}, ...(onExecutionOutput ? { onExecutionOutput: (_toolUseId: string, text: string) => onExecutionOutput(text) } : {}) });
    const def = createBashDefinition({ ...bashExecution(tasks), operations: commandOutputOps(output), executionOutputThrottleMs: 0 });
    return def.execute({ command: "echo streamed" }, makeContext({ executionCwd: "/mock", spawnOwned: ownedSpawnProbe().spawnOwned }));
  };

  it("captures a sanitized execution tail bounded to 1000 lines", async () => {
    const stdout = Array.from({ length: 1001 }, (_, index) => `line-${index}`).join("\n");
    const result = await runOutput(`\u001b[31m${stdout}\u001b[0m\u0000`);
    const tail = result.executionOutputTail ?? "";

    expect(tail.split("\n")).toHaveLength(1000);
    expect(tail.startsWith("line-1\n")).toBe(true);
    expect(tail.endsWith("line-1000")).toBe(true);
    expect(tail).not.toContain("\u001b");
    expect(tail).not.toContain("\u0000");
  });

  it("captures at most 256KiB of sanitized execution output", async () => {
    const result = await runOutput("x".repeat(300 * 1024));
    const tail = result.executionOutputTail ?? "";

    expect(new TextEncoder().encode(tail).byteLength).toBe(256 * 1024);
    expect(tail).toBe("x".repeat(256 * 1024));
  });

  it("keeps a trailing newline when line-bounding the execution tail", async () => {
    const stdout = Array.from({ length: 1500 }, (_, index) => `line-${index + 1}\n`).join("");
    const result = await runOutput(stdout);
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
    const result = await runOutput(content);
    const tail = result.executionOutputTail ?? "";

    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(tail.startsWith("x")).toBe(true);
    expect(tail).not.toContain("\uFFFD");
  });

  it("omits the execution tail entirely for empty output", async () => {
    const result = await runOutput("");

    expect("executionOutputTail" in result).toBe(false);
  });

  it("does not expose control payloads that begin before the live-tail window", async () => {
    const emitted: string[] = [];

    await runOutput(`safe\u001bP${"forged".repeat(10_000)}\u001b\\tail`, (text) => emitted.push(text));

    expect(emitted.at(-1)).toBe("safetail");
    expect(emitted.at(-1)?.length).toBeLessThanOrEqual(50 * 1024);
  });
});

describe("bash tool: timeout bounds", () => {
  const mockContext = () => makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned });

  it("reads millisecond timeouts and caps oversized seconds without dropping the deadline", async () => {
    let timeout: number | undefined;
    const def = createBashDefinition({
      operations: makeMockOps(),
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      shell: {
        run: async options => { timeout = options.timeoutSec; return { content: "done", outcome: "ok" }; },
        privateCopies: createPrivateCopyPool(),
        hasActiveCommands: () => false,
      },
    });
    const ctx = makeContext();
    for (const [requested, seconds, note] of [
      [5400, 3600, "Note: timeout was capped at 3600 seconds."],
      [120000, 120, "Note: timeout 120000 was read as milliseconds: 120 seconds."],
      [100000, 100, "Note: timeout 100000 was read as milliseconds: 100 seconds."],
      [10000, 10, "Note: timeout 10000 was read as milliseconds: 10 seconds."],
      [10001, 10.001, "Note: timeout 10001 was read as milliseconds: 10.001 seconds."],
      [4000000, 3600, "Note: timeout 4000000 was read as milliseconds: 4000 seconds; capped at 3600 seconds."],
    ] as const) {
      const result = await dispatch(def, { command: "echo hi", timeout: requested }, ctx);
      expect(result.outcome).toBe("ok");
      expect(result.content).toBe(`${note}\ndone`);
      expect(timeout).toBe(seconds);
    }
  });

  it("allows timeout at or below 3600s", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const ctx = mockContext();
    const result = await def.execute({ command: "echo hi", timeout: 3600 }, ctx);
    expect(result.outcome).toBe("ok");
  });

  it("works without explicit timeout", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const ctx = mockContext();
    const result = await def.execute({ command: "echo hi" }, ctx);
    expect(result.outcome).toBe("ok");
  });

  it("rejects a non-positive timeout (would fire the kill timer immediately)", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
    const result = await def.execute({ command: "echo hi", timeout: 0 }, mockContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("timeout must be greater than 0");
  });
});

describe("bash tool: interactive-command detection false-positives", () => {
  const runCommand = (command: string) => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
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
  const directory = temporaryDirectories();
  const runCommand = (command: string, availableTools: ReadonlySet<string>) => {
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
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
    const def = createBashDefinition({ ...bashExecution(), operations: makeMockOps(), readOnly: true });
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
    const writer = createBashDefinition({ ...bashExecution(), operations: makeMockOps() });
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
      const result = await dispatch(createBashDefinition({ ...bashExecution(), operations: makeMockOps(), ...options }), { command }, ctx);
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
    const run = async (mutatingDeclaration: boolean, input: RuntimeToolInput, scratchDir = "/proj/.flywheel/scratch") => {
      const spawn = ownedSpawnProbe();
      const ctx = makeContext({ executionCwd: "/proj", projectRoot: "/proj", scratchDir, spawnOwned: spawn.spawnOwned });
      const result = await dispatch(createBashDefinition({ ...bashExecution(), operations: makeMockOps(), mutatingDeclaration }), input, ctx);
      return { outcome: result.outcome, content: String(result.content), cwds: spawn.launches.map((launch) => launch.cwd) };
    };
    const declared = await run(false, { command: edit, mutates: true });
    expect(declared.outcome).toBe("error");
    expect(declared.content).toContain("unexpected parameter `mutates`");
    expect(declared.cwds).toEqual([]);
    const inPlace = await run(false, { command: edit });
    expect(inPlace.outcome).toBe("ok");
    expect(inPlace.cwds).toEqual(["/proj"]);
    // An interactive runtime takes the same declaration to its private-copy route, which first installs its Git shim
    // in the scratch directory. One below a file refuses that install on every platform, so the route ends before Git
    // runs; the fake root `/proj` cannot do that, because it is writable on Windows.
    const blocker = path.join(directory("bash-headless-"), "file");
    fs.writeFileSync(blocker, "");
    expect((await run(true, { command: edit, mutates: true }, path.join(blocker, "scratch"))).content).toContain("mutation Git wrapper");
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

  it("refuses a shell-level background job, and runs an ampersand inside quotes", async () => {
    const job = await runCommand("sleep 5 &", new Set(["bash"]));
    expect(job.outcome).toBe("error");
    expect(String(job.content)).toStartWith("Shell-level backgrounding was not executed.");
    expect((await runCommand("echo '&'", new Set(["bash"]))).outcome).toBe("ok");
  });

  it("refuses a shell-level background job also when the bash parser is unavailable", async () => {
    spyOn(treeSitter, "loadTreeSitterParser").mockRejectedValue(new Error("no wasm"));
    try {
      const job = await runCommand("sleep 5 &", new Set(["bash"]));
      expect(job.outcome).toBe("error");
      expect(String(job.content)).toStartWith("Shell-level backgrounding was not executed.");
    } finally {
      mock.restore();
    }
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
      ...bashExecution(),
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

  it("installs the BUN_BE_BUN bun and bunx shims once in binary mode and prepends their bin dir to PATH", async () => {
    const { def, dirs, shims, launches, spawnOwned } = makeRecordingDef("/opt/flywheel/flywheel", "linux");
    const ctx = makeContext({ executionCwd: "/mock", scratchDir, spawnOwned });

    const result = await def.execute({ command: "bun scratch.ts" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(dirs).toEqual([scratchDir, path.join(scratchDir, "bin")]);
    expect(shims).toEqual([
      { path: path.join(scratchDir, "bin", "bun"), content: '#!/bin/sh\nexec env BUN_BE_BUN=1 "/opt/flywheel/flywheel" "$@"\n' },
      { path: path.join(scratchDir, "bin", "bunx"), content: '#!/bin/sh\nexec env BUN_BE_BUN=1 "/opt/flywheel/flywheel" x "$@"\n' },
    ]);
    expect(launches[0]!.env!.PATH!.startsWith(path.join(scratchDir, "bin"))).toBe(true);

    // Second call reuses the prepared scratchpad: no re-write, same PATH prefix.
    await def.execute({ command: "bun scratch.ts" }, ctx);
    expect(shims).toHaveLength(2);
    expect(launches[1]!.env!.PATH!.startsWith(path.join(scratchDir, "bin"))).toBe(true);
  });

  it("writes bun.cmd and bunx.cmd shims on Windows", async () => {
    const { def, shims, spawnOwned } = makeRecordingDef("C:\\flywheel\\flywheel.exe", "win32");

    await def.execute({ command: "echo hi" }, makeContext({ executionCwd: "/mock", scratchDir, spawnOwned }));

    expect(shims).toEqual([
      { path: path.join(scratchDir, "bin", "bun.cmd"), content: '@echo off\r\nset BUN_BE_BUN=1\r\n"C:\\flywheel\\flywheel.exe" %*\r\n' },
      { path: path.join(scratchDir, "bin", "bunx.cmd"), content: '@echo off\r\nset BUN_BE_BUN=1\r\n"C:\\flywheel\\flywheel.exe" x %*\r\n' },
    ]);
  });

  it("installs the shims exactly once under concurrent first calls", async () => {
    let writes = 0;
    const def = createBashDefinition({
      ...bashExecution(),
      execPath: "/opt/flywheel/flywheel",
      loginShellPath: () => loginShellPath,
      operations: makeMockOps({
        writeExecutable: async () => {
          writes++;
          await Bun.sleep(5);
        },
      }),
    });
    const context = (toolUseId: string) => makeContext({ executionCwd: "/mock", scratchDir, spawnOwned: ownedSpawnProbe().spawnOwned, toolUseId });

    await Promise.all([
      def.execute({ command: "echo a" }, context("call-a")),
      def.execute({ command: "echo b" }, context("call-b")),
    ]);

    expect(writes).toBe(2);
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
  it("does not set fullContent when output is short enough to skip compression", async () => {
    const def = createBashDefinition({ ...bashExecution(), operations: commandOutputOps("hello\nworld\n") });
    const ctx = makeContext({ executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned });

    const result = await def.execute({ command: "echo hi" }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.fullContent).toBeUndefined();
  });
});

describe("bash tool: retained command log", () => {
  it("bounds multi-megabyte output, names the retained log with its measured size and digest, and sanitizes split control strings", async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bash-spool-"));
    try {
      const lines = Array.from({ length: 200_000 }, (_, index) => `${index + 1}`).join("\n");
      const payload = `\u001bP${"forged".repeat(1_000)}\u001b\\${lines}\n`;
      const def = createBashDefinition({ ...bashExecution(), operations: commandOutputOps(payload, { ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }) }) });
      const ctx = makeContext({ scratchDir, executionCwd: "/scratch", spawnOwned: ownedSpawnProbe().spawnOwned });

      const result = await def.execute({ command: "produce output" }, ctx);
      if (typeof result.content !== "string") throw new Error("bash returns text content");
      const retained = result.retainedFullContent;
      if (!retained) throw new Error("expected the retained log");
      const log = fs.readFileSync(retained.path);

      expect(result.content).toStartWith("1\n2\n");
      // The head keeps 6,000 bytes (lines 1-1422), and the tail keeps the last 12,000 and the line that crosses into them.
      expect(result.content).toContain("\n1422\n[... 196863 lines omitted ...]\n198286\n");
      expect(result.content).not.toContain("forged");
      expect(retained.path.startsWith(scratchDir)).toBe(true);
      expect(retained.bytes).toBe(new TextEncoder().encode(payload).byteLength);
      expect(retained.bytes).toBe(log.byteLength);
      expect(retained.sha256).toBe(new Bun.CryptoHasher("sha256").update(log).digest("hex"));
      expect(result.fullContent).toBeUndefined();
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
