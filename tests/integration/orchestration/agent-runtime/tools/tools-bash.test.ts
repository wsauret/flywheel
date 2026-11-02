import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";

const bashDefinition = createBashDefinition();
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { makeContext } from "../../../../unit/orchestration/agent-runtime/tools/_fixtures.js";
import { createPersistentProcessManager } from "../../../../../src/infra/persistent-process-manager.js";
import { FIXTURE_EXECUTION_CWD } from "../../../../helpers/directories.js";

beforeAll(async () => {
  await loadBashParser();
});

describe("bash tool: real subprocess", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes command and returns stdout + exit code", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    // Quoted, so it is one argument in either shell: PowerShell's `echo` is
    // `Write-Output`, which prints one line per object it is handed.
    const result = await bashDefinition.execute({ command: 'echo "hello world"' }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("[exit code: 0]");
  });

  it("omits the duration suffix for fast commands and carries durationMs in details", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bashDefinition.execute({ command: "echo quick" }, ctx);
    expect(result.content).toContain("[exit code: 0]");
    expect(result.content).not.toContain("[exit code: 0 in");
    expect(result.details).toMatchObject({ exitCode: 0, durationMs: expect.any(Number) });
  });

  it("reports non-zero exit code in content without marking tool as errored", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bashDefinition.execute({ command: "exit 42" }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("[exit code: 42]");
  });

  it("times out and returns error", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bashDefinition.execute({ command: "sleep 0.5", timeout: 0.1 }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("timed out");
  }, 5_000);

  it("refuses an ambiguous shell-level background job", async () => {
    const bash = createBashDefinition({ postExitDrainGraceMs: 150 });
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bash.execute({ command: "sleep 5 & echo done" }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Shell-level backgrounding was not executed");
  });

  it("refuses shell-level backgrounding before applying an explicit timeout", async () => {
    const bash = createBashDefinition({ postExitDrainGraceMs: 150 });
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bash.execute({ command: "sleep 5 & sleep 5", timeout: 0.2 }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Shell-level backgrounding was not executed");
  });

  it("strips ANSI escape sequences from result content at the subprocess boundary", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    fs.writeFileSync(
      path.join(tmpDir, "ansi-output.ts"),
      'process.stdout.write("\\x1b[0mline one\\n\\x1b[32m[RUN]\\x1b[0m\\n")',
    );
    const result = await bashDefinition.execute(
      { command: "bun ansi-output.ts" },
      ctx,
    );
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("line one\n[RUN]");
    expect(result.content).not.toContain("\u001b");
  });

  it("rejects interactive commands", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });

    for (const command of ["vim file.txt", "less output.log", "python"]) {
      expect(await bashDefinition.executionPolicy?.({ command }, ctx)).toContain("Interactive command detected");
    }
  });

  it("rejects interactive command after shell separator", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    expect(await bashDefinition.executionPolicy?.({ command: "echo hi && vim file.txt" }, ctx)).toContain("Interactive command detected");
  });

  it("returns aborted when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeContext({ executionCwd: tmpDir, signal: controller.signal });
    const result = await bashDefinition.execute({ command: "echo should not run" }, ctx);
    expect(result.outcome).toBe("interrupted");
    expect(result.content).toContain("aborted before it started");
  });
});

describe("bash tool: live execution output", () => {
  it("streams xtrace progress lines to the live tail without recording them", async () => {
    if (process.platform === "win32") return;
    const emitted: string[] = [];
    const ctx = makeContext({ executionCwd: FIXTURE_EXECUTION_CWD, onExecutionOutput: (text) => emitted.push(text) });

    const result = await bashDefinition.execute({ command: "sleep 0.05\necho traced" }, ctx);

    expect(result.outcome).toBe("ok");
    // BASH_XTRACEFD needs bash >= 4.1; on older bash the tool degrades to no
    // trace lines, so the live-tail expectation follows the resolved bash.
    const version = Bun.spawnSync(["bash", "-c", 'echo "$BASH_VERSION"'], { windowsHide: true }).stdout.toString().trim();
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major > 4 || (major === 4 && minor >= 1)) {
      expect(emitted.at(-1)).toContain("+ sleep 0.05");
    }
    expect(emitted.at(-1)).toContain("traced");
    expect(result.content).not.toContain("+ sleep");
    expect(result.content).toContain("traced");
  });
});

describe("bash tool: host shell multi-line quoting and persistent launch", () => {
  const persistentProcessManager = createPersistentProcessManager();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bash-host-"));
  });

  afterEach(async () => {
    // A persistent process holds its working directory open, and Windows
    // refuses to remove a directory a process is sitting in. `releaseAll`
    // surrenders ownership without ending anything, so every process a case
    // started is stopped before its scratch directory goes.
    const client = persistentProcessManager.client();
    try {
      for (const record of await client.list()) await client.stop(record.id);
    } finally {
      client.close();
    }
    persistentProcessManager.releaseAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // These two run the host's real shell, so each states the multi-line quoting
  // its own shell has: a Bash heredoc, and a PowerShell here-string. What both
  // prove is that the wrapper leaves a delimiter alone on its own line.
  it.skipIf(process.platform === "win32")("executes heredoc commands", async () => {
    const result = await bashDefinition.execute({
      command: "python3 << 'EOF'\nprint('heredoc-ok')\nEOF",
    }, makeContext({ executionCwd: tmpDir }));
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("heredoc-ok");
    expect(result.content).toContain("[exit code: 0]");
  });

  it.skipIf(process.platform !== "win32")("executes here-string commands", async () => {
    const result = await bashDefinition.execute({
      command: ["$body = @'", "heredoc-ok", "'@", "Write-Output $body"].join("\n"),
    }, makeContext({ executionCwd: tmpDir }));
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("heredoc-ok");
    expect(result.content).toContain("[exit code: 0]");
  });

  it("runs persistent background commands", async () => {
    const persistentProcesses = persistentProcessManager.client();
    try {
      const ctx = makeContext({ executionCwd: tmpDir, persistentProcesses, admitPersistentProcess: () => true });
      // Production builds bash with this option when allow_persistent_processes is on.
      const result = await createBashDefinition({ persistentProcesses: true }).execute({ command: "bun -e 'await Bun.sleep(30_000)'", background: true, persist_after_exit: true }, ctx);
      expect(result.outcome).toBe("ok");
      expect(result.content).toContain("Started persistent process");
      expect(result.content).toContain("PID:");
      expect((await persistentProcesses.list()).map((record) => record.status)).toEqual(["running"]);
    } finally {
      persistentProcesses.close();
    }
  });
});

describe("bash tool: held foreground command (real subprocess)", () => {
  let tmpDir: string;
  let scratchDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-bash-held-"));
    scratchDir = path.join(tmpDir, "scratch");
    fs.mkdirSync(scratchDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
  });

  const heldContext = (toolUseId: string) => makeContext({
    executionCwd: tmpDir,
    scratchDir,
    toolUseId,
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }),
    foregroundBashHold: createForegroundBashHoldController(() => {}),
  });

  it("reports the exit code a native program leaves", async () => {
    const command = process.platform === "win32" ? "cmd /c exit 3" : "sh -c 'exit 3'";

    const result = await bashDefinition.execute({ command }, heldContext("toolu_held_native_exit"));

    expect(result.details).toMatchObject({ background: false, exitCode: 3 });
    expect(result.content).toContain("[exit code: 3]");
  });

  it("keeps a bounded log private to the account and leaves nothing behind for a small one", async () => {
    if (process.platform === "win32") return;

    const small = await bashDefinition.execute({ command: "echo small output" }, heldContext("toolu_held_small_real"));
    expect(small.content).toContain("small output");
    expect(fs.readdirSync(scratchDir).filter((name) => name.startsWith("flywheel-agent-"))).toEqual([]);

    const large = await bashDefinition.execute({ command: "head -c 2000000 /dev/zero | tr '\\0' x" }, heldContext("toolu_held_large_real"));
    const named = large.retainedFullContent?.path ?? "";
    expect(named.startsWith(scratchDir)).toBe(true);
    expect(fs.statSync(named).size).toBe(2_000_000);
    expect(fs.statSync(named).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(scratchDir).filter((name) => name.startsWith("flywheel-agent-"))).toEqual([path.basename(named)]);
  });
});
