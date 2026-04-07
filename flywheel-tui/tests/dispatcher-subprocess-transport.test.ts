import { describe, it, expect, beforeEach } from "bun:test";
import type { DispatcherInput } from "../src/workflows/dispatcher/schemas";
import { DispatcherDecisionSchema, DispatcherDecisionHandoffSchema } from "../src/workflows/dispatcher/schemas";
import type { DispatcherDecisionHandoff } from "../src/workflows/dispatcher/schemas";

/**
 * Valid DispatcherDecisionHandoff — the shape the LLM writes to the handoff file.
 * This is the handoff schema (not the full DispatcherDecision).
 */
function validHandoff(overrides?: Partial<DispatcherDecisionHandoff>): DispatcherDecisionHandoff {
  return {
    schema_version: 1,
    step_index: 0,
    task_content: "Execute the setup step by creating directory layout",
    context_files: ["src/index.ts"],
    evaluation_criteria: {
      acceptance_criteria: ["Tests pass"],
      required_tests: false,
      custom_checks: [],
      required_outputs: [],
    },
    reasoning: "Standard setup step execution",
    ...overrides,
  };
}

function baseDispatcherInput(overrides?: Partial<DispatcherInput>): DispatcherInput {
  return {
    plan: { steps: [{ name: "Step 1", steps: [{ description: "step 1" }] }] },
    state: { completed_steps: [], current_step_index: 0 },
    workflow_id: "wf-test-001",
    workflow: { name: "work", step_number: 1, total_steps: 2, step_description: "Setup" },
    last_worker_result: null,
    config: { max_eval_cycles: 3, worktree_path: "/tmp/wt", project_cwd: "/tmp/proj", subprocess_model: "opus", dispatcher_model: "opus" },
    session_budget: { invocations_remaining: 100, token_budget_remaining: null, wall_clock_deadline: null },
    available_context: { conventions: [], standards: [], learnings: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PooledSubprocessTransport — pool-based dispatcher tests
// ---------------------------------------------------------------------------

import type { PoolHandle, PooledSpawnResult } from "../src/workflows/dispatcher/subprocess-transport";
import type { PooledSpawnResult as SharedPooledSpawnResult } from "../src/workflows/shared/invoke-pooled";

/**
 * Create a mock PoolHandle that returns controllable processes.
 *
 * @param handoffOrFn - static handoff object, or (acquireCount) => handoff | null.
 *   When null, no handoff file is written (simulating handoff-missing).
 * @param hooks - optional hooks for capturing stdin writes, acquire/release calls, etc.
 */
function createMockPool(
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
        pid: 10000 + acquires,
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
              // Write the handoff file, then resolve the process result
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
              // No handoff — still resolve the process (it exited normally)
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

describe("PooledSubprocessTransport: pool-based dispatcher", () => {
  let PooledSubprocessTransport: typeof import("../src/workflows/dispatcher/subprocess-transport").PooledSubprocessTransport;

  beforeEach(async () => {
    const mod = await import("../src/workflows/dispatcher/subprocess-transport");
    PooledSubprocessTransport = mod.PooledSubprocessTransport;
  });

  // -----------------------------------------------------------------------
  // Basic flow: acquire from pool, write NDJSON prompt via stdin, read result
  // -----------------------------------------------------------------------

  it("acquires from pool, writes NDJSON prompt via stdin, reads streamed result", async () => {
    let capturedStdinWrite = "";
    const handoff = validHandoff();

    const { pool } = createMockPool(handoff, {
      onStdinWrite: (msg) => { capturedStdinWrite += msg; },
    });

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseDispatcherInput());

    // Verify NDJSON format was used for stdin
    expect(capturedStdinWrite).toContain('"type":"user"');
    expect(capturedStdinWrite).toContain('"role":"user"');
    // Verify the prompt contains dispatcher content
    expect(capturedStdinWrite).toContain("dispatcher input");
    expect(capturedStdinWrite).toContain("Respond with valid JSON only");
    // Verify the result was correctly mapped from handoff
    expect(result.task_content).toBe(handoff.task_content);
  });

  // -----------------------------------------------------------------------
  // Stdin is closed after writing prompt (triggers process exit)
  // -----------------------------------------------------------------------

  it("closes stdin after writing prompt (triggers process exit)", async () => {
    let stdinClosed = false;

    const { pool } = createMockPool(validHandoff(), {
      onStdinClose: () => { stdinClosed = true; },
    });

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseDispatcherInput());
    expect(stdinClosed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Process exit is awaited before reading handoff file (no race)
  // -----------------------------------------------------------------------

  it("awaits process exit before reading handoff file (no race)", async () => {
    const events: string[] = [];

    const handoff = validHandoff();
    const { pool } = createMockPool(handoff, {
      onStdinClose: () => { events.push("stdin-closed"); },
    });

    // Patch to track event ordering — the mock pool resolves result after
    // writing the handoff, so if the test succeeds the ordering is correct.
    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseDispatcherInput());

    // If we got a valid result, process must have exited (writing handoff)
    // before the handoff was read.
    expect(events).toContain("stdin-closed");
    expect(result.task_content).toBe(handoff.task_content);
  });

  // -----------------------------------------------------------------------
  // Release is called after handoff read
  // -----------------------------------------------------------------------

  it("calls pool.release() after handoff read", async () => {
    const { pool, releaseCount } = createMockPool(validHandoff());

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseDispatcherInput());
    expect(releaseCount()).toBe(1);
  });

  // -----------------------------------------------------------------------
  // DispatcherDecisionHandoffSchema validation still works
  // -----------------------------------------------------------------------

  it("DispatcherDecisionHandoffSchema validation still works", async () => {
    const handoff = validHandoff({
      task_content: "Pool-validated task",
      evaluation_criteria: {
        acceptance_criteria: ["Tests pass"],
        required_tests: true,
        custom_checks: [],
        required_outputs: ["src/feature.ts"],
      },
    });

    const { pool } = createMockPool(handoff);

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseDispatcherInput());

    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe("Pool-validated task");
    expect(result.evaluation_criteria.required_tests).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Retry on HandoffMissingError acquires fresh from pool
  // -----------------------------------------------------------------------

  it("retry on HandoffMissingError acquires fresh from pool", async () => {
    const handoff = validHandoff();

    // First acquire: no handoff file; second acquire: handoff written
    const { pool, acquireCount, releaseCount } = createMockPool((n) => n >= 2 ? handoff : null);

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseDispatcherInput());

    expect(acquireCount()).toBe(2);
    expect(releaseCount()).toBe(2); // Both processes are released
    expect(result.task_content).toBe(handoff.task_content);
  });

  // -----------------------------------------------------------------------
  // Throws after both handoff reads fail
  // -----------------------------------------------------------------------

  it("throws after both handoff reads fail", async () => {
    // Never write a handoff file
    const { pool, acquireCount, releaseCount } = createMockPool(() => null);

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await expect(transport.invoke(baseDispatcherInput())).rejects.toThrow(/pooled invoke failed/);
    expect(acquireCount()).toBe(2); // Tried twice
    expect(releaseCount()).toBe(2); // Both released
  });

  // -----------------------------------------------------------------------
  // Prompt includes dispatcher handoff instruction with file path
  // -----------------------------------------------------------------------

  it("prompt includes dispatcher handoff instruction with file path", async () => {
    let capturedStdin = "";

    const { pool } = createMockPool(validHandoff(), {
      onStdinWrite: (msg) => { capturedStdin += msg; },
    });

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseDispatcherInput());

    expect(capturedStdin).toContain("Dispatcher Handoff Instructions");
    expect(capturedStdin).toContain(".flywheel/sessions/test-pool-session/handoffs/");
    expect(capturedStdin).toContain(".json");
    expect(capturedStdin).toContain("schema_version");
    expect(capturedStdin).toContain("task_content");
  });

  // -----------------------------------------------------------------------
  // Handoff → Decision mapping works with pool transport
  // -----------------------------------------------------------------------

  it("passes through handoff evaluation_criteria object to DispatcherDecision", async () => {
    const criteria = {
      acceptance_criteria: ["All tests must pass"],
      required_tests: true,
      custom_checks: ["lint clean"],
      required_outputs: ["src/feature.ts"],
    };
    const handoff = validHandoff({ evaluation_criteria: criteria });
    const { pool } = createMockPool(handoff);

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    const result = await transport.invoke(baseDispatcherInput());
    expect(result.evaluation_criteria).toEqual(criteria);
  });

  // -----------------------------------------------------------------------
  // System prompt is included in stdin message
  // -----------------------------------------------------------------------

  it("system prompt is included in stdin message", async () => {
    let capturedStdin = "";

    const { pool } = createMockPool(validHandoff(), {
      onStdinWrite: (msg) => { capturedStdin += msg; },
    });

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await transport.invoke(baseDispatcherInput());

    // System prompt should be present in the stdin content
    expect(capturedStdin).toContain("prompt engineering specialist");
  });

  // -----------------------------------------------------------------------
  // Process without stdin handle throws clear error
  // -----------------------------------------------------------------------

  it("throws clear error when process has no stdin handle", async () => {
    const pool: PoolHandle = {
      async acquire() {
        return {
          pid: 99999,
          // No stdinHandle!
          result: Promise.resolve({ output: "", exitCode: 0, truncated: false, durationMs: 10, handoffPath: "/tmp/x" }),
        };
      },
      release() {},
    };

    const transport = new PooledSubprocessTransport({
      pool,
      formatStdinMessage: testFormatStdinMessage,
      sessionId: "test-pool-session",
      baseDir: "/tmp/test",
    });

    await expect(transport.invoke(baseDispatcherInput())).rejects.toThrow(/no stdin handle/i);
  });
});

// ---------------------------------------------------------------------------
// invokePooled unit tests
// ---------------------------------------------------------------------------

describe("invokePooled: core pool invocation logic", () => {
  let invokePooled: typeof import("../src/workflows/shared/invoke-pooled").invokePooled;

  beforeEach(async () => {
    const mod = await import("../src/workflows/shared/invoke-pooled");
    invokePooled = mod.invokePooled;
  });

  it("acquires, writes stdin, awaits exit, reads handoff, releases", async () => {
    const events: string[] = [];
    const handoff = validHandoff();

    const { pool } = createMockPool(handoff, {
      onAcquire: () => events.push("acquire"),
      onStdinWrite: () => events.push("stdin-write"),
      onStdinClose: () => events.push("stdin-close"),
      onRelease: () => events.push("release"),
    });

    const result = await invokePooled(
      pool,
      {
        role: "dispatcher",
        buildHandoffPath: (sid, iid, base) => {
          const path = require("node:path");
          return path.resolve(base, `.flywheel/sessions/${sid}/handoffs/dispatcher_${iid}.json`);
        },
        buildFullPrompt: (handoffPath) => `Write JSON to \`${handoffPath}\``,
        systemPrompt: "You are a test",
        handoffSchema: DispatcherDecisionHandoffSchema,
        mapResult: (h: any) => h,
      },
      {
        sessionId: "test-invoke-pooled",
        baseDir: "/tmp/test",
        formatStdinMessage: testFormatStdinMessage,
      },
    );

    expect(events).toEqual(["acquire", "stdin-write", "stdin-close", "release"]);
    expect(result.task_content).toBe(handoff.task_content);
  });

  it("retries once on HandoffMissingError then succeeds", async () => {
    const handoff = validHandoff();

    const { pool, acquireCount } = createMockPool((n) => n >= 2 ? handoff : null);

    const result = await invokePooled(
      pool,
      {
        role: "dispatcher",
        buildHandoffPath: (sid, iid, base) => {
          const path = require("node:path");
          return path.resolve(base, `.flywheel/sessions/${sid}/handoffs/dispatcher_${iid}.json`);
        },
        buildFullPrompt: (handoffPath) => `Write JSON to \`${handoffPath}\``,
        systemPrompt: "You are a test",
        handoffSchema: DispatcherDecisionHandoffSchema,
        mapResult: (h: any) => h,
      },
      {
        sessionId: "test-invoke-pooled",
        baseDir: "/tmp/test",
        formatStdinMessage: testFormatStdinMessage,
      },
    );

    expect(acquireCount()).toBe(2);
    expect(result.task_content).toBe(handoff.task_content);
  });

  it("releases process even when handoff read fails both times", async () => {
    const { pool, releaseCount } = createMockPool(() => null);

    try {
      await invokePooled(
        pool,
        {
          role: "dispatcher",
          buildHandoffPath: (sid, iid, base) => {
            const path = require("node:path");
            return path.resolve(base, `.flywheel/sessions/${sid}/handoffs/dispatcher_${iid}.json`);
          },
          buildFullPrompt: (handoffPath) => `Write JSON to \`${handoffPath}\``,
          systemPrompt: "You are a test",
          handoffSchema: DispatcherDecisionHandoffSchema,
          mapResult: (h: any) => h,
        },
        {
          sessionId: "test-invoke-pooled",
          baseDir: "/tmp/test",
          formatStdinMessage: testFormatStdinMessage,
        },
      );
    } catch {
      // Expected
    }

    expect(releaseCount()).toBe(2); // Both attempts released
  });
});
