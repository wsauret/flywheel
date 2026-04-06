import { describe, it, expect, beforeEach } from "bun:test";
import type { EvaluatorInput, EvaluatorResult } from "../src/workflows/evaluator/schemas";
import { EvaluatorResultSchema } from "../src/workflows/evaluator/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEvaluatorResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All evaluation criteria met",
    suggestions: [],
    confidence: 0.9,
    feedback: "Good work",
    files_to_review: [],
    ...overrides,
  };
}

function baseEvaluatorInput(overrides?: Partial<EvaluatorInput>): EvaluatorInput {
  return {
    worker_output: "Worker completed the task successfully",
    evaluation_criteria: "Tests must pass",
    context_files: ["src/index.ts"],
    acceptance_criteria: ["must pass all tests"],
    artifacts_produced: ["src/new-file.ts"],
    tests_passed: true,
    duration_seconds: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PooledSubprocessEvaluatorTransport — pool-based evaluator tests
// ---------------------------------------------------------------------------

import type { PoolHandle, PooledSpawnResult } from "../src/workflows/evaluator/subprocess-transport";
import type { PooledSpawnResult as SharedPooledSpawnResult } from "../src/workflows/shared/invoke-pooled";

/**
 * Create a mock PoolHandle for evaluator tests.
 *
 * @param handoffOrFn - static handoff object, or (acquireCount) => handoff | null.
 *   When null, no handoff file is written (simulating handoff-missing).
 * @param hooks - optional hooks for capturing stdin writes, acquire/release calls, etc.
 */
function createMockEvaluatorPool(
  handoffOrFn: Record<string, unknown> | ((acquireCount: number) => Record<string, unknown> | null),
  hooks?: {
    onAcquire?: (count: number) => void;
    onRelease?: (proc: PooledSpawnResult) => void;
    onStdinWrite?: (message: string) => void;
    onStdinClose?: () => void;
  },
): { pool: PoolHandle; acquireCount: () => number; releaseCount: () => number } {
  let acquires = 0;
  let releases = 0;

  const pool: PoolHandle = {
    async acquire(): Promise<PooledSpawnResult> {
      acquires++;
      hooks?.onAcquire?.(acquires);

      let stdinWritten = "";
      let stdinClosed = false;
      let resolveResult: (value: any) => void;

      const resultPromise = new Promise<any>((resolve) => {
        resolveResult = resolve;
      });

      const proc: PooledSpawnResult = {
        pid: 20000 + acquires,
        stdinHandle: {
          write(message: string) {
            stdinWritten += message;
            hooks?.onStdinWrite?.(message);
            return true;
          },
          close() {
            stdinClosed = true;
            hooks?.onStdinClose?.();

            // On stdin close, extract handoff path from written content and write handoff file
            const handoff = typeof handoffOrFn === "function" ? handoffOrFn(acquires) : handoffOrFn;
            const pathMatch = stdinWritten.match(/`([^`]+\.json)`/);

            if (handoff && pathMatch) {
              Bun.write(pathMatch[1], JSON.stringify(handoff)).then(() => {
                resolveResult!({
                  output: "",
                  exitCode: 0,
                  truncated: false,
                  durationMs: 50,
                  handoffPath: pathMatch[1],
                });
              });
            } else {
              resolveResult!({
                output: "",
                exitCode: 0,
                truncated: false,
                durationMs: 50,
                handoffPath: "/tmp/no-handoff",
              });
            }
          },
          get isOpen() {
            return !stdinClosed;
          },
        },
        result: resultPromise,
      };

      return proc;
    },
    release(proc: PooledSpawnResult) {
      releases++;
      hooks?.onRelease?.(proc);
    },
  };

  return { pool, acquireCount: () => acquires, releaseCount: () => releases };
}

/** Simple NDJSON formatter for tests — mirrors formatStdinMessage. */
function testFormatStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

describe("PooledSubprocessEvaluatorTransport: pool-based evaluator", () => {
  let PooledSubprocessEvaluatorTransport: typeof import("../src/workflows/evaluator/subprocess-transport").PooledSubprocessEvaluatorTransport;

  beforeEach(async () => {
    const mod = await import("../src/workflows/evaluator/subprocess-transport");
    PooledSubprocessEvaluatorTransport = mod.PooledSubprocessEvaluatorTransport;
  });

  // -----------------------------------------------------------------------
  // Basic flow: acquire from pool, write NDJSON prompt via stdin, read verdict
  // -----------------------------------------------------------------------

  it("acquires from pool, writes NDJSON prompt via formatStdinMessage, reads verdict", async () => {
    let capturedStdinWrite = "";
    const verdict = validEvaluatorResult({ reasoning: "Pool-based verdict" });

    const { pool } = createMockEvaluatorPool(verdict, {
      onStdinWrite: (msg) => { capturedStdinWrite += msg; },
    });

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseEvaluatorInput());

    // Verify NDJSON format was used for stdin
    expect(capturedStdinWrite).toContain('"type":"user"');
    expect(capturedStdinWrite).toContain('"role":"user"');
    // Verify the prompt contains evaluator content
    expect(capturedStdinWrite).toContain("Verdict");
    expect(capturedStdinWrite).toContain("passed");
    // Verify the result was correctly mapped from handoff
    expect(result.reasoning).toBe("Pool-based verdict");
    expect(result.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // EvaluatorVerdictSchema validation still works on handoff file
  // -----------------------------------------------------------------------

  it("EvaluatorVerdictSchema validation still works on handoff file", async () => {
    const verdict = validEvaluatorResult({
      reasoning: "Schema-validated verdict",
      confidence: 0.85,
      suggestions: ["Consider edge cases"],
    });

    const { pool } = createMockEvaluatorPool(verdict);

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseEvaluatorInput());

    const parsed = EvaluatorResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.reasoning).toBe("Schema-validated verdict");
    expect(result.confidence).toBe(0.85);
    expect(result.suggestions).toEqual(["Consider edge cases"]);
  });

  // -----------------------------------------------------------------------
  // Transport releases process after verdict read
  // -----------------------------------------------------------------------

  it("releases process after verdict read", async () => {
    const { pool, releaseCount } = createMockEvaluatorPool(validEvaluatorResult());

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseEvaluatorInput());
    expect(releaseCount()).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Retry on handoff error acquires fresh from pool
  // -----------------------------------------------------------------------

  it("retry on handoff error acquires fresh from pool", async () => {
    const verdict = validEvaluatorResult();

    // First acquire: no handoff file; second acquire: handoff written
    const { pool, acquireCount, releaseCount } = createMockEvaluatorPool((n) => n >= 2 ? verdict : null);

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseEvaluatorInput());

    expect(acquireCount()).toBe(2);
    expect(releaseCount()).toBe(2); // Both processes are released
    expect(result.passed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Throws after both handoff reads fail
  // -----------------------------------------------------------------------

  it("throws after both handoff reads fail", async () => {
    const { pool, acquireCount, releaseCount } = createMockEvaluatorPool(() => null);

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await expect(transport.invoke(baseEvaluatorInput())).rejects.toThrow(/pooled invoke failed/);
    expect(acquireCount()).toBe(2); // Tried twice
    expect(releaseCount()).toBe(2); // Both released
  });

  // -----------------------------------------------------------------------
  // Stdin is closed after writing prompt (triggers process exit)
  // -----------------------------------------------------------------------

  it("closes stdin after writing prompt", async () => {
    let stdinClosed = false;

    const { pool } = createMockEvaluatorPool(validEvaluatorResult(), {
      onStdinClose: () => { stdinClosed = true; },
    });

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseEvaluatorInput());
    expect(stdinClosed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // System prompt is included in stdin message
  // -----------------------------------------------------------------------

  it("includes evaluator system prompt in stdin content", async () => {
    let capturedStdin = "";

    const { pool } = createMockEvaluatorPool(validEvaluatorResult(), {
      onStdinWrite: (msg) => { capturedStdin += msg; },
    });

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseEvaluatorInput());

    // System prompt should be present in the stdin content
    expect(capturedStdin).toContain("verification agent");
  });

  // -----------------------------------------------------------------------
  // Handoff path contains session-scoped evaluator path
  // -----------------------------------------------------------------------

  it("handoff path contains session-scoped evaluator path", async () => {
    let capturedStdin = "";

    const { pool } = createMockEvaluatorPool(validEvaluatorResult(), {
      onStdinWrite: (msg) => { capturedStdin += msg; },
    });

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseEvaluatorInput());

    expect(capturedStdin).toContain("Evaluator");
    expect(capturedStdin).toContain(".flywheel/sessions/test-pool-session/handoffs/");
    expect(capturedStdin).toContain(".json");
  });

  // -----------------------------------------------------------------------
  // No stdin handle throws clear error
  // -----------------------------------------------------------------------

  it("throws clear error when process has no stdin handle", async () => {
    const pool: PoolHandle = {
      async acquire() {
        return {
          pid: 99999,
          // No stdinHandle!
          result: Promise.resolve({ output: "", exitCode: 0 }),
        };
      },
      release() {},
    };

    const transport = new PooledSubprocessEvaluatorTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await expect(transport.invoke(baseEvaluatorInput())).rejects.toThrow(/no stdin handle/i);
  });
});

