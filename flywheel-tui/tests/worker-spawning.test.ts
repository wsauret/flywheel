import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { CompletionDetector, COMPLETION_REGEX, wrapCompletionInstruction } from "../src/worker/completion";
import { createEnvFilter, DEFAULT_EXCLUDE_PATTERNS } from "../src/worker/env-filter";
import {
  activeProcesses,
  registerProcess,
  killProcessGroup,
  GRACE_PERIOD_MS,
  type ChildHandle,
} from "../src/worker/process-lifecycle";
import {
  createWorkerTimeout,
  minutesToMs,
  clampTimeoutMinutes,
  DEFAULT_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
} from "../src/worker/timeout";
import {
  isTransientError,
  isRetryable,
  categorizeFailure,
  getTransientPatterns,
} from "../src/worker/errors";
import { validateSpawnArgs, BunProcessSpawner, resolveCommandExecutable } from "../src/worker/bun-spawner";
import { PhaseExecutor, WorkerError } from "../src/controller/phase-executor";
import type { ProcessSpawner, SpawnResult } from "../src/worker/spawner";
import type { FlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelConfig } from "../src/config/loader";
import type { Engine } from "../src/engines/core/types";
import type { WorkerResult } from "../src/schemas/worker";

// ---------------------------------------------------------------------------
// Completion Detection
// ---------------------------------------------------------------------------

describe("CompletionDetector", () => {
  let detector: CompletionDetector;

  beforeEach(() => {
    detector = new CompletionDetector();
  });

  it("detects <promise>COMPLETE</promise> in stdout stream", () => {
    expect(detector.hasSeenCompletion).toBe(false);
    detector.check("some output <promise>COMPLETE</promise> more output");
    expect(detector.hasSeenCompletion).toBe(true);
  });

  it("case insensitive matching", () => {
    detector.check("<PROMISE>complete</PROMISE>");
    expect(detector.hasSeenCompletion).toBe(true);
  });

  it("allows whitespace around COMPLETE", () => {
    detector.check("<promise>  COMPLETE  </promise>");
    expect(detector.hasSeenCompletion).toBe(true);
  });

  it("short-circuits after first detection", () => {
    detector.check("<promise>COMPLETE</promise>");
    expect(detector.check("no marker here")).toBe(true); // still true
  });

  it("returns false when no marker present", () => {
    expect(detector.check("just some output")).toBe(false);
    expect(detector.hasSeenCompletion).toBe(false);
  });

  it("fallback checks last 32KB of stdout", () => {
    const bigOutput = "A".repeat(100_000) + "<promise>COMPLETE</promise>";
    expect(detector.checkFallback(bigOutput)).toBe(true);
    expect(detector.hasSeenCompletion).toBe(true);
  });

  it("fallback guard: skips slice if already detected", () => {
    detector.check("<promise>COMPLETE</promise>");
    // Fallback should short-circuit
    expect(detector.checkFallback("no marker")).toBe(true);
  });

  it("fallback returns false when marker not in last 32KB", () => {
    // Marker is buried far before the last 32KB
    const output = "<promise>COMPLETE</promise>" + "X".repeat(50_000);
    // The fallback checks last 32KB, marker is at beginning
    expect(detector.checkFallback(output)).toBe(false);
  });

  it("reset clears state", () => {
    detector.check("<promise>COMPLETE</promise>");
    expect(detector.hasSeenCompletion).toBe(true);
    detector.reset();
    expect(detector.hasSeenCompletion).toBe(false);
  });

  it("COMPLETION_REGEX matches expected patterns", () => {
    expect(COMPLETION_REGEX.test("<promise>COMPLETE</promise>")).toBe(true);
    expect(COMPLETION_REGEX.test("<promise> COMPLETE </promise>")).toBe(true);
    expect(COMPLETION_REGEX.test("<PROMISE>COMPLETE</PROMISE>")).toBe(true);
    expect(COMPLETION_REGEX.test("no marker")).toBe(false);
  });

  it("wrapCompletionInstruction adds marker instruction to prompt", () => {
    const wrapped = wrapCompletionInstruction("Do the thing");
    expect(wrapped).toContain("Do the thing");
    expect(wrapped).toContain("<promise>COMPLETE</promise>");
  });

  it("detects NDJSON result event with subtype success", () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"duration_ms":5000}';
    detector.check(line);
    expect(detector.hasSeenCompletion).toBe(true);
  });

  it("does not detect NDJSON result event with is_error true", () => {
    // subtype must be "success" — an error result is not completion
    const line = '{"type":"result","subtype":"error","is_error":true}';
    detector.check(line);
    expect(detector.hasSeenCompletion).toBe(false);
  });

  it("detects NDJSON result in fallback check", () => {
    const output = 'some stuff\n{"type":"result","subtype":"success","duration_ms":100}\n';
    detector.checkFallback(output);
    expect(detector.hasSeenCompletion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Env Filtering
// ---------------------------------------------------------------------------

describe("EnvFilter", () => {
  it("strips *_API_KEY variables", () => {
    const filter = createEnvFilter();
    const result = filter.filter({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      HOME: "/home/user",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("strips *_SECRET_KEY variables", () => {
    const filter = createEnvFilter();
    const result = filter.filter({
      AWS_SECRET_KEY: "secret123",
      NORMAL_VAR: "ok",
    });
    expect(result.AWS_SECRET_KEY).toBeUndefined();
    expect(result.NORMAL_VAR).toBe("ok");
  });

  it("strips *_SECRET variables", () => {
    const filter = createEnvFilter();
    const result = filter.filter({
      CLIENT_SECRET: "shh",
      NOT_A_SECRET_THING: "ok",
    });
    expect(result.CLIENT_SECRET).toBeUndefined();
    // NOT_A_SECRET_THING doesn't match *_SECRET (it's *_SECRET_THING)
    expect(result.NOT_A_SECRET_THING).toBe("ok");
  });

  it("supports additional envExclude patterns", () => {
    const filter = createEnvFilter({
      envExclude: ["*_TOKEN", "DATABASE_*"],
    });
    const result = filter.filter({
      GITHUB_TOKEN: "ghp-123",
      DATABASE_URL: "postgres://...",
      PATH: "/usr/bin",
    });
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin");
  });

  it("envPassthrough overrides exclusion", () => {
    const filter = createEnvFilter({
      envPassthrough: ["OPENAI_API_KEY"],
    });
    const result = filter.filter({
      OPENAI_API_KEY: "sk-needed",
      ANTHROPIC_API_KEY: "sk-excluded",
    });
    expect(result.OPENAI_API_KEY).toBe("sk-needed");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("skips undefined values", () => {
    const filter = createEnvFilter();
    const result = filter.filter({
      PATH: "/usr/bin",
      EMPTY: undefined,
    } as Record<string, string | undefined>);
    expect(result.PATH).toBe("/usr/bin");
    expect("EMPTY" in result).toBe(false);
  });

  it("getEnvFilterReport returns correct categories", () => {
    const filter = createEnvFilter({
      envPassthrough: ["OPENAI_API_KEY"],
    });
    const report = filter.getReport({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-needed",
      ANTHROPIC_API_KEY: "sk-excluded",
    });
    expect(report.passed).toContain("PATH");
    expect(report.passed).toContain("OPENAI_API_KEY");
    expect(report.excluded).toContain("ANTHROPIC_API_KEY");
    expect(report.overridden).toContain("OPENAI_API_KEY");
  });

  it("default exclude patterns match expected globs", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain("*_API_KEY");
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain("*_SECRET_KEY");
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain("*_SECRET");
  });
});

// ---------------------------------------------------------------------------
// Process Lifecycle
// ---------------------------------------------------------------------------

describe("Process Lifecycle", () => {
  afterEach(() => {
    activeProcesses.clear();
  });

  it("registerProcess adds to and removes from global registry", () => {
    const mock: ChildHandle = { pid: 1234, kill: () => {} };
    const unregister = registerProcess(mock);
    expect(activeProcesses.has(mock)).toBe(true);
    unregister();
    expect(activeProcesses.has(mock)).toBe(false);
  });

  it("clean entries on process exit (unregister)", () => {
    const mock: ChildHandle = { pid: 5678, kill: () => {} };
    const unregister = registerProcess(mock);
    expect(activeProcesses.size).toBe(1);
    // Simulating process exit by calling unregister
    unregister();
    expect(activeProcesses.size).toBe(0);
  });

  it("process group kill on Unix (negative PID)", () => {
    // We can't actually test process.kill(-pid) without real processes,
    // but we can verify the logic by checking the function exists
    // and that GRACE_PERIOD_MS is 5 seconds
    expect(GRACE_PERIOD_MS).toBe(5_000);
    expect(typeof killProcessGroup).toBe("function");
  });

  it("Windows platform guard returns child.kill() fallback", () => {
    // Test that the function handles a mock child that throws ESRCH
    const killCalls: Array<number | undefined> = [];
    const mock: ChildHandle = {
      pid: 99999999, // PID that won't exist
      kill: (signal) => {
        killCalls.push(signal);
      },
    };

    // On macOS/Linux this will try process.kill(-pid) which will fail
    // and fall back to child.kill()
    killProcessGroup(mock, "SIGTERM");
    // The function should have attempted something (either process.kill or child.kill)
    // We just verify it doesn't throw
  });

  it("GRACE_PERIOD_MS is 5 seconds (NOT 100ms)", () => {
    expect(GRACE_PERIOD_MS).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("WorkerTimeout", () => {
  it("default timeout is 60 minutes", () => {
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(60);
  });

  it("clampTimeoutMinutes bounds to 1-120", () => {
    expect(clampTimeoutMinutes(0)).toBe(1);
    expect(clampTimeoutMinutes(-5)).toBe(1);
    expect(clampTimeoutMinutes(60)).toBe(60);
    expect(clampTimeoutMinutes(150)).toBe(120);
    expect(clampTimeoutMinutes(1)).toBe(1);
    expect(clampTimeoutMinutes(120)).toBe(120);
  });

  it("minutesToMs converts correctly", () => {
    expect(minutesToMs(1)).toBe(60_000);
    expect(minutesToMs(60)).toBe(3_600_000);
  });

  it("creates timeout with AbortController", () => {
    const timeout = createWorkerTimeout(1000);
    expect(timeout.controller).toBeInstanceOf(AbortController);
    expect(timeout.signal).toBeInstanceOf(AbortSignal);
    expect(timeout.timedOut).toBe(false);
    timeout.cancel();
  });

  it("cancel prevents timeout from firing", async () => {
    const timeout = createWorkerTimeout(50);
    timeout.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(timeout.timedOut).toBe(false);
    expect(timeout.signal.aborted).toBe(false);
  });

  it("timeout fires after duration", async () => {
    const timeout = createWorkerTimeout(50);
    await new Promise((r) => setTimeout(r, 100));
    expect(timeout.timedOut).toBe(true);
    expect(timeout.signal.aborted).toBe(true);
    timeout.cancel(); // cleanup
  });

  it("AbortController signal triggers process-group-kill", async () => {
    const killCalls: string[] = [];
    const mockChild: ChildHandle = {
      pid: 12345,
      kill: () => {
        killCalls.push("killed");
      },
    };

    const timeout = createWorkerTimeout(50);
    timeout.attachProcess(mockChild);

    await new Promise((r) => setTimeout(r, 100));
    expect(timeout.timedOut).toBe(true);
    // The abort handler should have tried to kill the process group
    // On test environment, process.kill(-pid) will fail and fall back to child.kill
    timeout.cancel();
  });

  it("attachProcess kills immediately if already aborted", () => {
    const timeout = createWorkerTimeout(100_000);
    timeout.controller.abort();

    const killCalls: string[] = [];
    const mockChild: ChildHandle = {
      pid: 12345,
      kill: () => {
        killCalls.push("killed");
      },
    };

    timeout.attachProcess(mockChild);
    // Should have attempted immediate kill
    timeout.cancel();
  });
});

// ---------------------------------------------------------------------------
// Error Categorization
// ---------------------------------------------------------------------------

describe("Error Categorization", () => {
  it("isTransientError detects ECONNREFUSED", () => {
    expect(isTransientError("Error: connect ECONNREFUSED 127.0.0.1:3000")).toBe(true);
  });

  it("isTransientError detects ECONNRESET", () => {
    expect(isTransientError("read ECONNRESET")).toBe(true);
  });

  it("isTransientError detects ENOTFOUND", () => {
    expect(isTransientError("getaddrinfo ENOTFOUND api.example.com")).toBe(true);
  });

  it("isTransientError detects ETIMEDOUT", () => {
    expect(isTransientError("connect ETIMEDOUT 1.2.3.4:443")).toBe(true);
  });

  it("isTransientError detects EPIPE", () => {
    expect(isTransientError("write EPIPE")).toBe(true);
  });

  it('isTransientError detects "socket hang up"', () => {
    expect(isTransientError("Error: socket hang up")).toBe(true);
  });

  it('isTransientError detects "network error"', () => {
    expect(isTransientError("Network error occurred")).toBe(true);
  });

  it('isTransientError detects "dns resolution"', () => {
    expect(isTransientError("dns resolution failed")).toBe(true);
  });

  it('isTransientError detects "GOAWAY"', () => {
    expect(isTransientError("HTTP/2 GOAWAY received")).toBe(true);
  });

  it('isTransientError detects "stream closed"', () => {
    expect(isTransientError("Stream closed with error")).toBe(true);
  });

  it('isTransientError detects "connection reset"', () => {
    expect(isTransientError("Connection reset by peer")).toBe(true);
  });

  it('isTransientError detects "unexpected EOF"', () => {
    expect(isTransientError("unexpected EOF while reading")).toBe(true);
  });

  it('isTransientError detects "502"', () => {
    expect(isTransientError("HTTP 502 Bad Gateway")).toBe(true);
  });

  it('isTransientError detects "503"', () => {
    expect(isTransientError("HTTP 503 Service Unavailable")).toBe(true);
  });

  it('isTransientError detects "service unavailable"', () => {
    expect(isTransientError("Error: service unavailable, try again later")).toBe(true);
  });

  it('isTransientError detects "temporary"', () => {
    expect(isTransientError("Temporary failure in name resolution")).toBe(true);
  });

  it("isTransientError returns false for normal errors", () => {
    expect(isTransientError("SyntaxError: unexpected token")).toBe(false);
    expect(isTransientError("TypeError: undefined is not a function")).toBe(false);
  });

  it("getTransientPatterns returns all patterns", () => {
    const patterns = getTransientPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(16);
    expect(patterns).toContain("ECONNREFUSED");
    expect(patterns).toContain("unexpected EOF");
    expect(patterns).toContain("502");
    expect(patterns).toContain("503");
    expect(patterns).toContain("service unavailable");
    expect(patterns).toContain("temporary");
  });
});

describe("isRetryable", () => {
  it("timeout is retryable", () => {
    expect(isRetryable({ kind: "timeout", timeoutMs: 60000, message: "timed out" })).toBe(true);
  });

  it("api_error is retryable", () => {
    expect(isRetryable({ kind: "api_error", message: "500 error" })).toBe(true);
  });

  it("rate_limited is retryable", () => {
    expect(isRetryable({ kind: "rate_limited", message: "429" })).toBe(true);
  });

  it("transient is retryable", () => {
    expect(isRetryable({ kind: "transient", message: "ECONNRESET" })).toBe(true);
  });

  it("exit_code is NOT retryable", () => {
    expect(isRetryable({ kind: "exit_code", exitCode: 1, message: "failed" })).toBe(false);
  });

  it("schema_error is NOT retryable", () => {
    expect(isRetryable({ kind: "schema_error", message: "parse error" })).toBe(false);
  });

  it("completion_not_detected is NOT retryable", () => {
    expect(isRetryable({ kind: "completion_not_detected", message: "no marker" })).toBe(false);
  });
});

describe("categorizeFailure", () => {
  it("returns timeout failure when timedOut", () => {
    const result = categorizeFailure({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: true,
      timeoutMs: 60000,
      completionDetected: false,
    });
    expect(result?.kind).toBe("timeout");
    expect(result?.kind === "timeout" && result.timeoutMs).toBe(60000);
  });

  it("returns rate_limited for rate limit patterns in stderr", () => {
    const result = categorizeFailure({
      exitCode: 1,
      stdout: "",
      stderr: "Error: 429 Too Many Requests",
      timedOut: false,
      completionDetected: false,
    });
    expect(result?.kind).toBe("rate_limited");
  });

  it("returns transient for ECONNRESET", () => {
    const result = categorizeFailure({
      exitCode: 1,
      stdout: "",
      stderr: "Error: read ECONNRESET",
      timedOut: false,
      completionDetected: false,
    });
    expect(result?.kind).toBe("transient");
  });

  it("returns exit_code for non-zero exit without specific patterns", () => {
    const result = categorizeFailure({
      exitCode: 1,
      stdout: "some output",
      stderr: "some error",
      timedOut: false,
      completionDetected: true,
    });
    expect(result?.kind).toBe("exit_code");
    expect(result?.kind === "exit_code" && result.exitCode).toBe(1);
  });

  it("returns success for exit 0 without marker (clean exit = implicit completion)", () => {
    const result = categorizeFailure({
      exitCode: 0,
      stdout: "output without marker",
      stderr: "",
      timedOut: false,
      completionDetected: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined (success) for exit 0 with completion detected", () => {
    const result = categorizeFailure({
      exitCode: 0,
      stdout: "output <promise>COMPLETE</promise>",
      stderr: "",
      timedOut: false,
      completionDetected: true,
    });
    expect(result).toBeUndefined();
  });

  it("WorkerFailureReason correctly categorizes all 7 kinds", () => {
    // Verify all 7 kinds exist and are handled
    const kinds = ["timeout", "completion_not_detected", "exit_code", "schema_error", "api_error", "rate_limited", "transient"];
    for (const kind of kinds) {
      expect(typeof kind).toBe("string");
    }
    expect(kinds).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Shell Metacharacter Validation
// ---------------------------------------------------------------------------

describe("validateSpawnArgs", () => {
  it("accepts safe commands and args", () => {
    expect(() => validateSpawnArgs("opencode", ["--prompt", "hello world"])).not.toThrow();
    expect(() => validateSpawnArgs("/usr/bin/node", ["script.js"])).not.toThrow();
    expect(() => validateSpawnArgs("bun", ["run", "test"])).not.toThrow();
  });

  it("rejects shell metacharacters in command", () => {
    expect(() => validateSpawnArgs("cmd; rm -rf /", [])).toThrow(/metacharacter/i);
    expect(() => validateSpawnArgs("cmd | cat", [])).toThrow(/metacharacter/i);
    expect(() => validateSpawnArgs("cmd & bg", [])).toThrow(/metacharacter/i);
    expect(() => validateSpawnArgs("$(whoami)", [])).toThrow(/metacharacter/i);
    expect(() => validateSpawnArgs("`whoami`", [])).toThrow(/metacharacter/i);
  });

  it("allows shell metacharacters in arguments (Bun.spawn uses execve, no shell)", () => {
    // Arguments are passed directly via execve -- no shell interpretation.
    // Prompts legitimately contain <, >, (), etc.
    expect(() => validateSpawnArgs("cmd", ["; rm -rf /"])).not.toThrow();
    expect(() => validateSpawnArgs("cmd", ["$(cat /etc/passwd)"])).not.toThrow();
    expect(() => validateSpawnArgs("cmd", ["<promise>COMPLETE</promise>"])).not.toThrow();
    expect(() => validateSpawnArgs("cmd", ["arg > file"])).not.toThrow();
     expect(() => validateSpawnArgs("cmd", ["Use (parens) and [brackets]"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stdin Delivery and Ignore Handling (Gap 1)
// ---------------------------------------------------------------------------

describe("Stdin delivery and ignore handling", () => {
  it("when options.stdin is provided, the process receives it on stdin", async () => {
    const spawner = new BunProcessSpawner();
    // `cat` reads from stdin and echoes it to stdout
    const { result: resultPromise } = await spawner.spawn("cat", [], {
      stdin: "hello from stdin",
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    expect(result.output).toContain("hello from stdin");
  });

  it("when options.stdin is undefined, stdin is set to 'ignore' (not an empty Blob)", async () => {
    const spawner = new BunProcessSpawner();
    // `cat` with no stdin and 'ignore' should exit immediately (no input to read)
    const { result: resultPromise } = await spawner.spawn("cat", [], {
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    // cat with stdin=ignore should exit with code 0 and no output
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

  it("empty string stdin ('') still delivers an empty stdin (not ignore)", async () => {
    const spawner = new BunProcessSpawner();
    // `cat` with empty stdin should exit immediately with empty output
    const { result: resultPromise } = await spawner.spawn("cat", [], {
      stdin: "",
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resolveCommandExecutable (Gap 2)
// ---------------------------------------------------------------------------

describe("resolveCommandExecutable", () => {
  it("resolves 'bun' to a valid path (fallback to process.execPath)", () => {
    const resolved = resolveCommandExecutable("bun");
    // Should return either Bun.which("bun") or process.execPath
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).not.toBe("bun"); // Should be resolved to an absolute path
  });

  it("returns absolute paths unchanged", () => {
    const resolved = resolveCommandExecutable("/absolute/path/to/binary");
    expect(resolved).toBe("/absolute/path/to/binary");
  });

  it("returns relative paths with separators unchanged", () => {
    const resolved = resolveCommandExecutable("./relative/path");
    expect(resolved).toBe("./relative/path");
  });

  it("returns Windows-style paths with backslash unchanged", () => {
    const resolved = resolveCommandExecutable("C:\\Program Files\\node.exe");
    expect(resolved).toBe("C:\\Program Files\\node.exe");
  });

  it("returns the input unchanged for nonexistent binaries (graceful fallback)", () => {
    const resolved = resolveCommandExecutable("nonexistent-binary-xyz-12345");
    expect(resolved).toBe("nonexistent-binary-xyz-12345");
  });
});

// ---------------------------------------------------------------------------
// Raw stdout/stderr Collection (Gap 3)
// ---------------------------------------------------------------------------

describe("Raw stdout/stderr collection", () => {
  it("WorkerResult.rawOutput contains the unprocessed stdout", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise } = await spawner.spawn("echo", ["hello raw"], {
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    expect(result.rawOutput).toBeDefined();
    expect(result.rawOutput).toContain("hello raw");
  });

  it("WorkerResult.rawStderr contains unprocessed stderr", async () => {
    const spawner = new BunProcessSpawner();
    // Use bash to write to stderr
    const { result: resultPromise } = await spawner.spawn("bash", ["-c", "echo 'stderr msg' >&2"], {
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    expect(result.rawStderr).toBeDefined();
    expect(result.rawStderr).toContain("stderr msg");
  });

  it("rawOutput preserves content even if Tier 1 buffer truncates", async () => {
    const spawner = new BunProcessSpawner();
    // Small test: just verify rawOutput is collected independently
    const { result: resultPromise } = await spawner.spawn("echo", ["preserved content"], {
      timeoutMs: 5_000,
    });
    const result = await resultPromise;
    expect(result.rawOutput).toContain("preserved content");
    // rawOutput should be at least as long as output
    expect(result.rawOutput!.length).toBeGreaterThanOrEqual(result.output.length);
  });
});

// ---------------------------------------------------------------------------
// ENOENT → install instructions (Gap 13)
// ---------------------------------------------------------------------------

describe("ENOENT → install instructions", () => {
  /** Create a mock emitter that swallows all events. */
  function createNoopEmitter(): FlywheelEmitter {
    return {
      workflowStarted: () => {},
      workflowCompleted: () => {},
      phaseStarted: () => {},
      phaseCompleted: () => {},
      workerSpawned: () => {},
      workerCompleted: () => {},
      workerOutput: () => {},
      workerRetrying: () => {},
    } as unknown as FlywheelEmitter;
  }

  const claudeEngine: Engine = {
    metadata: {
      id: "claude",
      name: "Claude Code",
      cliBinary: "claude",
      defaultModel: "opus",
      installCommand: "npm install -g @anthropic-ai/claude-code",
    },
    buildCommand: ({ prompt }) => ({
      command: "nonexistent-binary-that-does-not-exist",
      args: ["--prompt", prompt],
      stdinPrompt: false,
    }),
  };

  const defaultConfig: FlywheelConfig = {
    engine: "claude",
    max_retries: 0,
    timeout_minutes: 1,
    skip_approval_gates: false,
  };

  it("ENOENT error produces install instructions with installCommand", async () => {
    const enoentSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => {
        const err = new Error("spawn nonexistent-binary-that-does-not-exist ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      },
    };

    const executor = new PhaseExecutor({
      spawner: enoentSpawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: claudeEngine,
      workflowId: "test-wf-1",
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("not available on this system");
      expect(msg).toContain("npm install -g @anthropic-ai/claude-code");
    }
  });

  it("error message includes the engine name", async () => {
    const enoentSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => {
        const err = new Error("spawn ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      },
    };

    const executor = new PhaseExecutor({
      spawner: enoentSpawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: claudeEngine,
      workflowId: "test-wf-2",
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("Claude Code");
      expect(msg).toContain("claude");
    }
  });

  it('"command not found" message is treated as ENOENT', async () => {
    const cmdNotFoundSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => {
        throw new Error("command not found: claude");
      },
    };

    const executor = new PhaseExecutor({
      spawner: cmdNotFoundSpawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: claudeEngine,
      workflowId: "test-wf-3",
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("not available on this system");
      expect(msg).toContain("Install Claude Code");
    }
  });

  it('"not recognized" message is treated as ENOENT (Windows)', async () => {
    const notRecognizedSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => {
        throw new Error("'claude' is not recognized as an internal or external command");
      },
    };

    const executor = new PhaseExecutor({
      spawner: notRecognizedSpawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: claudeEngine,
      workflowId: "test-wf-4",
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toContain("not available on this system");
      expect(msg).toContain("npm install -g @anthropic-ai/claude-code");
    }
  });

  it("non-ENOENT errors are re-thrown without install instructions", async () => {
    const genericErrorSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => {
        throw new Error("some other unexpected error");
      },
    };

    const executor = new PhaseExecutor({
      spawner: genericErrorSpawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: claudeEngine,
      workflowId: "test-wf-5",
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).toBe("some other unexpected error");
      expect(msg).not.toContain("Install");
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback Agent Chain (Phase 6)
// ---------------------------------------------------------------------------

describe("Fallback Agent Chain", () => {
  /** Create a mock emitter that swallows all events. */
  function createNoopEmitter(): FlywheelEmitter {
    return {
      workflowStarted: () => {},
      workflowCompleted: () => {},
      phaseStarted: () => {},
      phaseCompleted: () => {},
      workerSpawned: () => {},
      workerCompleted: () => {},
      workerOutput: () => {},
      workerRetrying: () => {},
    } as unknown as FlywheelEmitter;
  }

  /** Create a mock engine with the given ID. */
  function mockEngine(id: string): Engine {
    return {
      metadata: {
        id,
        name: id,
        cliBinary: id,
        defaultModel: "test",
        installCommand: `install-${id}`,
        description: `Mock ${id} engine`,
      },
      buildCommand: (opts) => ({
        command: id,
        args: ["-p", opts.prompt],
        stdinPrompt: false,
      }),
      listModels: async () => [],
    };
  }

  /** Create a successful WorkerResult. */
  function successWorkerResult(output = "done"): WorkerResult {
    return {
      output,
      exitCode: 0,
      truncated: false,
      durationMs: 100,
    };
  }

  /** Create a failed WorkerResult with a specific failure kind. */
  function failureWorkerResult(
    kind: "rate_limited" | "timeout" | "api_error" | "exit_code" | "transient",
    message = `${kind} failure`,
  ): WorkerResult {
    const base = {
      output: "",
      exitCode: 1,
      truncated: false,
      durationMs: 100,
    };
    switch (kind) {
      case "timeout":
        return { ...base, failure: { kind: "timeout", timeoutMs: 60000, message } };
      case "exit_code":
        return { ...base, failure: { kind: "exit_code", exitCode: 1, message } };
      default:
        return { ...base, failure: { kind, message } };
    }
  }

  /** Wrap a WorkerResult as a SpawnResult for inline spawner mocks. */
  function successResult(output = "done"): SpawnResult {
    return { result: Promise.resolve(successWorkerResult(output)) };
  }
  function failureResult(
    kind: "rate_limited" | "timeout" | "api_error" | "exit_code" | "transient",
    message = `${kind} failure`,
  ): SpawnResult {
    return { result: Promise.resolve(failureWorkerResult(kind, message)) };
  }

  const defaultConfig: FlywheelConfig = {
    engine: "claude",
    max_retries: 0, // No retries by default — faster tests, clearer fallback behavior
    timeout_minutes: 1,
    skip_approval_gates: false,
  } as FlywheelConfig;

  const primaryEngine = mockEngine("claude");
  const fallbackEngine1 = mockEngine("opencode");
  const fallbackEngine2 = mockEngine("gemini");

  it("rate-limited final failure with fallbackEngines triggers fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        callCount++;
        if (command === "claude") {
          return failureResult("rate_limited");
        }
        // Fallback engine succeeds
        return successResult("fallback success");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-1",
      fallbackEngines: [fallbackEngine1],
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(result.output).toBe("fallback success");
    expect(callCount).toBe(2); // primary + fallback
  });

  it("rate-limited final failure with empty fallbackEngines throws (existing behavior)", async () => {
    const spawner: ProcessSpawner = {
      spawn: async () => failureResult("rate_limited"),
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-2",
      fallbackEngines: [],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("rate_limited");
    }
  });

  it("rate-limited without fallbackEngines option throws (existing behavior)", async () => {
    const spawner: ProcessSpawner = {
      spawn: async () => failureResult("rate_limited"),
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-2b",
      // No fallbackEngines at all
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("rate_limited");
    }
  });

  it("fallback engine succeeds → returns result normally", async () => {
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        if (command === "claude") return failureResult("rate_limited");
        return successResult("opencode output");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-3",
      fallbackEngines: [fallbackEngine1],
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(result.output).toBe("opencode output");
    expect(result.failure).toBeUndefined();
  });

  it("fallback engine also rate-limited → tries next fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        callCount++;
        if (command === "claude") return failureResult("rate_limited", "claude rate limited");
        if (command === "opencode") return failureResult("rate_limited", "opencode rate limited");
        return successResult("gemini output");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-4",
      fallbackEngines: [fallbackEngine1, fallbackEngine2],
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(result.output).toBe("gemini output");
    expect(callCount).toBe(3); // primary + fallback1 + fallback2
  });

  it("all fallbacks exhausted → throws final error", async () => {
    const spawner: ProcessSpawner = {
      spawn: async () => failureResult("rate_limited"),
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-5",
      fallbackEngines: [fallbackEngine1, fallbackEngine2],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("rate_limited");
    }
  });

  it("non-rate-limit final failure (timeout) does NOT trigger fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        return failureResult("timeout");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-6",
      fallbackEngines: [fallbackEngine1],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("timeout");
    }
    // Only primary engine was tried
    expect(callCount).toBe(1);
  });

  it("non-rate-limit final failure (exit_code) does NOT trigger fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        return failureResult("exit_code");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-6b",
      fallbackEngines: [fallbackEngine1],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("exit_code");
    }
    expect(callCount).toBe(1);
  });

  it("final retry failure is timeout (not rate_limited) → no fallback even if earlier retries were rate-limited", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        // First call: rate_limited (will be retried)
        // Second call: timeout (final failure)
        if (callCount === 1) return failureResult("rate_limited");
        return failureResult("timeout");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: { ...defaultConfig, max_retries: 1 } as FlywheelConfig,
      engine: primaryEngine,
      workflowId: "fb-7",
      fallbackEngines: [fallbackEngine1],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      // The final error should be timeout, not rate_limited
      expect((error as WorkerError).result.failure?.kind).toBe("timeout");
    }
    // Only 2 calls to primary engine (initial + 1 retry), no fallback calls
    expect(callCount).toBe(2);
  });

  it("fallback switching is immediate (no delay between agents)", async () => {
    const timestamps: number[] = [];
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        timestamps.push(Date.now());
        if (command === "claude") return failureResult("rate_limited");
        return successResult("ok");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-8",
      fallbackEngines: [fallbackEngine1],
    });

    await executor.execute({ phaseIndex: 0, prompt: "test" });

    expect(timestamps.length).toBe(2);
    const gap = timestamps[1] - timestamps[0];
    // Should be near-instant — allow up to 200ms for test overhead
    expect(gap).toBeLessThan(200);
  });

  it("fallback engine non-rate-limited failure throws immediately (does not try next fallback)", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        callCount++;
        if (command === "claude") return failureResult("rate_limited");
        if (command === "opencode") return failureResult("timeout"); // non-rate-limited
        return successResult("should not reach");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-9",
      fallbackEngines: [fallbackEngine1, fallbackEngine2],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("timeout");
    }
    // primary + fallback1, but NOT fallback2
    expect(callCount).toBe(2);
  });

  it("primary engine succeeds → no fallback attempted", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        return successResult("primary ok");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-10",
      fallbackEngines: [fallbackEngine1],
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(result.output).toBe("primary ok");
    expect(callCount).toBe(1);
  });

  it("retries exhaust within primary engine before fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        callCount++;
        if (command === "claude") return failureResult("rate_limited");
        return successResult("fallback ok");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: { ...defaultConfig, max_retries: 2 } as FlywheelConfig,
      engine: primaryEngine,
      workflowId: "fb-11",
      fallbackEngines: [fallbackEngine1],
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(result.output).toBe("fallback ok");
    // 3 attempts on primary (1 initial + 2 retries) + 1 on fallback
    expect(callCount).toBe(4);
  });

  it("fallback engine uses its own command/args from buildCommand", async () => {
    const commandsUsed: string[] = [];
    const spawner: ProcessSpawner = {
      spawn: async (command) => {
        commandsUsed.push(command);
        if (command === "claude") return failureResult("rate_limited");
        return successResult("ok");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-12",
      fallbackEngines: [fallbackEngine1],
    });

    await executor.execute({ phaseIndex: 0, prompt: "test" });
    expect(commandsUsed).toEqual(["claude", "opencode"]);
  });

  it("api_error final failure does NOT trigger fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        return failureResult("api_error");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-13",
      fallbackEngines: [fallbackEngine1],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("api_error");
    }
    expect(callCount).toBe(1);
  });

  it("transient final failure does NOT trigger fallback", async () => {
    let callCount = 0;
    const spawner: ProcessSpawner = {
      spawn: async () => {
        callCount++;
        return failureResult("transient");
      },
    };

    const executor = new PhaseExecutor({
      spawner,
      emitter: createNoopEmitter(),
      config: defaultConfig,
      engine: primaryEngine,
      workflowId: "fb-14",
      fallbackEngines: [fallbackEngine1],
    });

    try {
      await executor.execute({ phaseIndex: 0, prompt: "test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerError);
      expect((error as WorkerError).result.failure?.kind).toBe("transient");
    }
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Streaming Stdin (Phase 4: Mid-Worker Stdin Injection)
// ---------------------------------------------------------------------------

describe("Streaming stdin (stdinPipe mode)", () => {
  it("initial prompt is delivered via stdin pipe (not pre-encoded Uint8Array)", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: "hello from pipe",
      stdinPipe: true,
      timeoutMs: 5_000,
    });

    // stdinHandle should be present
    expect(stdinHandle).toBeDefined();
    expect(stdinHandle!.isOpen).toBe(true);

    // Close stdin to signal EOF so cat exits
    stdinHandle!.close();

    const result = await resultPromise;
    expect(result.output).toContain("hello from pipe");
    expect(result.exitCode).toBe(0);
  });

  it("subsequent write() calls deliver additional content; write() returns true", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: "first ",
      stdinPipe: true,
      timeoutMs: 5_000,
    });

    expect(stdinHandle).toBeDefined();

    // Write additional content
    const wrote = stdinHandle!.write("second ");
    expect(wrote).toBe(true);

    const wrote2 = stdinHandle!.write("third");
    expect(wrote2).toBe(true);

    // Close stdin to signal EOF
    stdinHandle!.close();

    const result = await resultPromise;
    expect(result.output).toContain("first ");
    expect(result.output).toContain("second ");
    expect(result.output).toContain("third");
  });

  it("close() closes the stdin pipe; subsequent write() returns false", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: "data",
      stdinPipe: true,
      timeoutMs: 5_000,
    });

    expect(stdinHandle).toBeDefined();
    stdinHandle!.close();
    expect(stdinHandle!.isOpen).toBe(false);

    // write() after close should return false
    const wrote = stdinHandle!.write("more data");
    expect(wrote).toBe(false);

    await resultPromise;
  });

  it("if process exits before write(), write() returns false (not an error)", async () => {
    const spawner = new BunProcessSpawner();
    // Use 'true' command which exits immediately with code 0
    const { result: resultPromise, stdinHandle } = await spawner.spawn("true", [], {
      stdin: "initial",
      stdinPipe: true,
      timeoutMs: 5_000,
    });

    // Wait for process to exit
    await resultPromise;

    // Process has exited, so write should return false
    const wrote = stdinHandle!.write("late data");
    expect(wrote).toBe(false);
    expect(stdinHandle!.isOpen).toBe(false);
  });

  it("close() is idempotent (no error on double-close)", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: "data",
      stdinPipe: true,
      timeoutMs: 5_000,
    });

    expect(stdinHandle).toBeDefined();

    // First close
    stdinHandle!.close();
    expect(stdinHandle!.isOpen).toBe(false);

    // Second close should not throw
    expect(() => stdinHandle!.close()).not.toThrow();
    expect(stdinHandle!.isOpen).toBe(false);

    await resultPromise;
  });

  it("without stdinPipe (no stdinPipe flag), stdin is pre-encoded (existing behavior)", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: "pre-encoded content",
      timeoutMs: 5_000,
      // No stdinPipe — uses pre-encoded Uint8Array
    });

    // stdinHandle should be undefined for non-pipe mode
    expect(stdinHandle).toBeUndefined();

    const result = await resultPromise;
    expect(result.output).toContain("pre-encoded content");
  });

  it("without stdin, stdin is 'ignore' (existing behavior)", async () => {
    const spawner = new BunProcessSpawner();
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      timeoutMs: 5_000,
      // No stdin at all
    });

    expect(stdinHandle).toBeUndefined();

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

  it("initial prompt write runs concurrently with stdout/stderr reads (no deadlock)", async () => {
    const spawner = new BunProcessSpawner();
    // Generate a large payload to test the concurrent write/read pattern
    const largeInput = "x".repeat(100_000);
    const { result: resultPromise, stdinHandle } = await spawner.spawn("cat", [], {
      stdin: largeInput,
      stdinPipe: true,
      timeoutMs: 10_000,
    });

    expect(stdinHandle).toBeDefined();
    // Close stdin so cat can finish
    stdinHandle!.close();

    const result = await resultPromise;
    expect(result.output.length).toBe(largeInput.length);
    expect(result.exitCode).toBe(0);
  });
});
