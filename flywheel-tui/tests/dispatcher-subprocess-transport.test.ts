import { describe, it, expect, beforeEach } from "bun:test";
import type { DispatcherInput, DispatcherDecision } from "../src/schemas/dispatcher";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";
import type { DispatcherDecisionHandoff } from "../src/schemas/handoff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Valid DispatcherDecision — the mapped output after handoff → decision conversion.
 * Used for schema validation assertions.
 */
function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
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
    context: { files: [] },
    plan_truncated: false,
    history_truncated: false,
    workflow_id: "wf-test-001",
    workflow: { name: "work", step_number: 1, total_steps: 2, step_description: "Setup" },
    last_worker_result: null,
    config: { max_eval_cycles: 3, worktree_path: "/tmp/wt", project_cwd: "/tmp/proj", worker_model: "opus", dispatcher_model: "opus" },
    session_budget: { invocations_remaining: 100, token_budget_remaining: null, wall_clock_deadline: null },
    available_context: { conventions: [], standards: [], learnings: [] },
    ...overrides,
  };
}

/**
 * Extract the handoff path from a dispatcher prompt and write a handoff file.
 * The dispatcher transport now reads decisions from handoff files, not stdout.
 */
async function writeHandoffFromPrompt(prompt: string, handoff: Record<string, unknown>): Promise<void> {
  const pathMatch = prompt.match(/`([^`]+\.json)`/);
  if (pathMatch) {
    await Bun.write(pathMatch[1], JSON.stringify(handoff));
  }
}

/**
 * Extract the prompt from spawner args (Claude: -p flag, OpenCode: stdin).
 */
function extractPromptFromArgs(args: string[], options?: { stdin?: string }): string {
  const pIdx = args.indexOf("-p");
  if (pIdx > -1) return args[pIdx + 1];
  if (options?.stdin) return options.stdin;
  return "";
}

/**
 * Create a mock spawner that auto-writes a dispatcher handoff file.
 * Extracts the handoff path from the prompt and writes the handoff JSON file.
 *
 * @param handoffOrFn - static handoff object, or a function(callCount) => handoff | null.
 *   When null, no handoff is written (simulating handoff-missing).
 * @param hooks - optional hooks for capturing args, env, stdin, etc.
 */
function createHandoffSpawner(
  handoffOrFn: Record<string, unknown> | ((callCount: number) => Record<string, unknown> | null),
  hooks?: {
    onSpawn?: (command: string, args: string[], options?: SpawnOptions) => void;
  },
): { spawner: ProcessSpawner; callCount: () => number } {
  let calls = 0;
  const spawner: ProcessSpawner = {
    async spawn(command, args, options) {
      calls++;
      hooks?.onSpawn?.(command, args, options);

      const prompt = extractPromptFromArgs(args, options);
      const handoff = typeof handoffOrFn === "function" ? handoffOrFn(calls) : handoffOrFn;
      if (handoff) {
        await writeHandoffFromPrompt(prompt, handoff);
      }

      return {
        result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 100,
          handoffPath: "/tmp/unused",
        }),
      };
    },
  };
  return { spawner, callCount: () => calls };
}

// ---------------------------------------------------------------------------
// SubprocessTransport — engine-aware tests (handoff-based)
// ---------------------------------------------------------------------------

describe("SubprocessTransport: engine-aware command building", () => {
  let SubprocessTransport: typeof import("../src/dispatcher/subprocess-transport").SubprocessTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    SubprocessTransport = mod.SubprocessTransport;
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-001: Engine-aware transport selection
  // -----------------------------------------------------------------------

  it("spawns 'claude' engine when engineName is 'claude'", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (command, args) => {
        spawnedCommand = command;
        spawnedArgs = args;
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedCommand).toBe("claude");
    expect(spawnedArgs).toContain("-p");
    expect(spawnedArgs).toContain("--tools");
    expect(spawnedArgs).toContain("--no-session-persistence");
    expect(spawnedArgs).toContain("--effort");
  });

  it("spawns 'opencode' engine when engineName is 'opencode'", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (command, args) => {
        spawnedCommand = command;
        spawnedArgs = args;
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedCommand).toBe("opencode");
    expect(spawnedArgs).toContain("run");
    expect(spawnedArgs).toContain("--format");
    expect(spawnedArgs).toContain("json");
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-002: Claude Code dispatcher optimization flags
  // -----------------------------------------------------------------------

  it("Claude route includes --system-prompt flag (not concatenated)", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("--system-prompt");
    const sysIdx = spawnedArgs.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    // The system prompt value should be present and non-empty
    expect(spawnedArgs[sysIdx + 1]).toBeTruthy();
    expect(spawnedArgs[sysIdx + 1]).toContain("prompt engineering specialist");
  });

  it("Claude route passes prompt via -p flag (not stdin)", async () => {
    let spawnedArgs: string[] = [];
    let receivedStdin: string | undefined;

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args, options) => {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("-p");
    // Claude route should NOT use stdin for prompt delivery
    expect(receivedStdin).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-003: OpenCode dispatcher optimization flags
  // -----------------------------------------------------------------------

  it("OpenCode route passes prompt via stdin", async () => {
    let receivedStdin = "";

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, _args, options) => {
        receivedStdin = options?.stdin ?? "";
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    // OpenCode uses stdin for prompt delivery
    expect(receivedStdin).toBeTruthy();
    expect(receivedStdin).toContain("prompt engineering specialist");
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-004: Dispatcher model configuration flow
  // -----------------------------------------------------------------------

  it("config.dispatcher.model flows through to --model CLI flag", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      dispatcherModel: "haiku",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  it("config.dispatcher.model flows through to --model for opencode", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      dispatcherModel: "anthropic/claude-haiku-4-5",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-haiku-4-5");
  });

  // -----------------------------------------------------------------------
  // VAL-CFG-001: Default model is Sonnet
  // -----------------------------------------------------------------------

  it("defaults to 'sonnet' model for claude when not configured", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      // No dispatcherModel — should use engine default
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("sonnet");
  });

  it("defaults to 'anthropic/claude-sonnet-4-6' model for opencode when not configured", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-005: Dispatcher produces valid decision (handoff → decision mapping)
  // -----------------------------------------------------------------------

  it("response validates against DispatcherDecisionSchema (claude route)", async () => {
    const handoff = validHandoff();
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());

    // Should be a valid DispatcherDecision after handoff mapping
    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe(handoff.task_content);
  });

  it("response validates against DispatcherDecisionSchema (opencode route)", async () => {
    const handoff = validHandoff();
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());

    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe(handoff.task_content);
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-007: Handoff-based output reading (replaces stdout parsing)
  // -----------------------------------------------------------------------

  it("decision read from handoff file (opencode route)", async () => {
    const handoff = validHandoff({ task_content: "Handoff-based decision (opencode)" });
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(result.task_content).toBe("Handoff-based decision (opencode)");
  });

  it("decision read from handoff file (claude route)", async () => {
    const handoff = validHandoff({ task_content: "Handoff-based decision (claude)" });
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(result.task_content).toBe("Handoff-based decision (claude)");
  });

  // -----------------------------------------------------------------------
  // Handoff → Decision mapping
  // -----------------------------------------------------------------------

  it("passes through handoff evaluation_criteria object to DispatcherDecision", async () => {
    const criteria = {
      acceptance_criteria: ["All tests must pass"],
      required_tests: true,
      custom_checks: ["lint clean"],
      required_outputs: ["src/feature.ts"],
    };
    const handoff = validHandoff({ evaluation_criteria: criteria });
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());

    expect(result.evaluation_criteria).toEqual(criteria);
  });

  it("maps missing evaluation_criteria to empty acceptance_criteria", async () => {
    const handoff = validHandoff();
    delete (handoff as any).evaluation_criteria;
    const { spawner } = createHandoffSpawner(handoff);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());

    expect(result.evaluation_criteria).toEqual({
      acceptance_criteria: [],
      required_tests: false,
      custom_checks: [],
      required_outputs: [],
    });
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-008: Graceful error when engine binary not found
  // -----------------------------------------------------------------------

  it("throws clear error when engine binary not found (claude)", async () => {
    const { spawner } = createHandoffSpawner(validHandoff());

    // Use a fake engine name that won't match any registered engine
    try {
      const transport = new SubprocessTransport({
        spawner,
        engineName: "nonexistent-engine",
      sessionId: "test-session",
      baseDir: "/tmp/test",
      });
      await transport.invoke(baseDispatcherInput());
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("nonexistent-engine");
    }
  });

  // -----------------------------------------------------------------------
  // Existing behavior: retry-once-on-handoff-failure
  // -----------------------------------------------------------------------

  it("retries once on handoff missing then succeeds", async () => {
    const handoff = validHandoff();
    // First call: no handoff file; second call: handoff written
    const { spawner, callCount } = createHandoffSpawner((n) => n >= 2 ? handoff : null);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(callCount()).toBe(2);
    expect(result.task_content).toBe(handoff.task_content);
  });

  it("throws after both handoff reads fail", async () => {
    // Never write a handoff file
    const { spawner } = createHandoffSpawner(() => null);

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await expect(transport.invoke(baseDispatcherInput())).rejects.toThrow();
  });

  it("respects 60s timeout", async () => {
    let receivedTimeout: number | undefined;

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, _args, options) => {
        receivedTimeout = options?.timeoutMs;
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());
    expect(receivedTimeout).toBe(60_000);
  });

  // -----------------------------------------------------------------------
  // VAL-CFG-003: Backward compatibility — no engineName defaults to opencode
  // -----------------------------------------------------------------------

  it("backward compat: no engineName defaults to legacy opencode behavior", async () => {
    let spawnedCommand = "";

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (command) => { spawnedCommand = command; },
    });

    // Construct without engineName — should still work like before
    const transport = new SubprocessTransport({ spawner, sessionId: "test-session", baseDir: "/tmp/test" });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedCommand).toBe("opencode");
  });

  // -----------------------------------------------------------------------
  // Prompt includes handoff instruction
  // -----------------------------------------------------------------------

  it("prompt includes dispatcher handoff instruction with file path", async () => {
    let capturedPrompt = "";

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args, options) => {
        capturedPrompt = extractPromptFromArgs(args, options);
      },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    expect(capturedPrompt).toContain("Dispatcher Handoff Instructions");
    expect(capturedPrompt).toContain(".flywheel/sessions/test-session/handoffs/");
    expect(capturedPrompt).toContain(".json");
    expect(capturedPrompt).toContain("schema_version");
    expect(capturedPrompt).toContain("task_content");
  });
});

// ---------------------------------------------------------------------------
// Auto-detect: engine-aware tests
// ---------------------------------------------------------------------------

describe("Auto-detect transport: engine-aware", () => {
  let autoDetectTransport: typeof import("../src/dispatcher/auto-detect").autoDetectTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/auto-detect");
    autoDetectTransport = mod.autoDetectTransport;
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-006: Auto-detect respects engine configuration
  // -----------------------------------------------------------------------

  it("skips SDK for claude engine — always uses CLI", async () => {
    // Auto-detect only checks transport type, doesn't invoke — no handoff needed
    const { spawner } = createHandoffSpawner(validHandoff());

    const result = await autoDetectTransport({
      spawner,
      engineName: "claude",
    });

    // Claude should always use CLI (subprocess), never SDK
    expect(result.label).toBe("cli");
  });

  it("tries SDK first for opencode engine (existing behavior)", async () => {
    const { spawner } = createHandoffSpawner(validHandoff());

    const result = await autoDetectTransport({
      spawner,
      engineName: "opencode",
    });

    // OpenCode can be SDK or CLI depending on SDK availability
    expect(["sdk", "cli"]).toContain(result.label);
  });

  it("passes engineName through to SubprocessTransport on fallback", async () => {
    const { spawner } = createHandoffSpawner(validHandoff());

    const result = await autoDetectTransport({
      spawner,
      engineName: "claude",
    });

    // The transport should be a SubprocessTransport configured for claude
    expect(result.label).toBe("cli");
    expect(result.transport).toBeDefined();
  });

  it("passes dispatcherModel through to SubprocessTransport", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const result = await autoDetectTransport({
      spawner,
      engineName: "claude",
      dispatcherModel: "haiku",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });

    // Invoke the transport to verify the model is passed through
    await result.transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  // -----------------------------------------------------------------------
  // VAL-SDK-003: SDK transport is OpenCode-only
  // -----------------------------------------------------------------------

  it("never attempts SDK for claude engine even when SDK is available", async () => {
    const { spawner } = createHandoffSpawner(validHandoff());

    const result = await autoDetectTransport({
      spawner,
      engineName: "claude",
    });

    // Claude should NEVER get SDK transport
    expect(result.label).toBe("cli");
  });
});

// ---------------------------------------------------------------------------
// Config model flow tests
// ---------------------------------------------------------------------------

describe("Config model flow through transport chain", () => {
  let SubprocessTransport: typeof import("../src/dispatcher/subprocess-transport").SubprocessTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    SubprocessTransport = mod.SubprocessTransport;
  });

  // -----------------------------------------------------------------------
  // VAL-CFG-002: Config override propagation
  // -----------------------------------------------------------------------

  it("dispatcher.model in config changes the --model flag (claude)", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "claude",
      dispatcherModel: "opus",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("opus");
  });

  it("dispatcher.model in config changes the --model flag (opencode)", async () => {
    let spawnedArgs: string[] = [];

    const { spawner } = createHandoffSpawner(validHandoff(), {
      onSpawn: (_cmd, args) => { spawnedArgs = args; },
    });

    const transport = new SubprocessTransport({
      spawner,
      engineName: "opencode",
      dispatcherModel: "anthropic/claude-opus-4-6",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-001: Worker spawn path unaffected
// This is validated by the existing test suite (worker commands are not changed).
// We verify here that SubprocessTransport does NOT affect step-executor.
// ---------------------------------------------------------------------------

describe("Worker spawn path unaffected", () => {
  it("SubprocessTransport does not export or modify StepExecutor", async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    // SubprocessTransport is the only export that matters here
    expect(mod.SubprocessTransport).toBeDefined();
    // Should not have any step-executor-related exports
    expect((mod as any).StepExecutor).toBeUndefined();
  });
});
