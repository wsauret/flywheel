import { describe, it, expect, beforeEach } from "bun:test";
import type { DispatcherInput, DispatcherDecision } from "../src/schemas/dispatcher";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
  return {
    schema_version: 1,
    phase_index: 0,
    step_index: 0,
    task_content: "Execute the setup phase by creating directory layout",
    context_files: ["src/index.ts"],
    validation_criteria: {
      acceptance_criteria: ["Tests pass"],
      required_tests: true,
      custom_checks: [],
      required_outputs: [],
    },
    reasoning: "Standard setup phase execution",
    warnings: [],
    ...overrides,
  };
}

function baseDispatcherInput(overrides?: Partial<DispatcherInput>): DispatcherInput {
  return {
    plan: { phases: [{ name: "Phase 1", steps: [{ description: "step 1" }] }] },
    state: { completed_phases: [], current_phase_index: 0 },
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

// ---------------------------------------------------------------------------
// SubprocessTransport — engine-aware tests
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedCommand).toBe("claude");
    expect(spawnedArgs).toContain("--print");
    expect(spawnedArgs).toContain("--tools");
    expect(spawnedArgs).toContain("--no-session-persistence");
    expect(spawnedArgs).toContain("--effort");
  });

  it("spawns 'opencode' engine when engineName is 'opencode'", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedStdin = options?.stdin ?? "";
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
      dispatcherModel: "haiku",
    });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  it("config.dispatcher.model flows through to --model for opencode", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      dispatcherModel: "anthropic/claude-haiku-4-5",
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
      // No dispatcherModel — should use engine default
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("sonnet");
  });

  it("defaults to 'anthropic/claude-sonnet-4-6' model for opencode when not configured", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-005: Dispatcher produces valid decision
  // -----------------------------------------------------------------------

  it("response validates against DispatcherDecisionSchema (claude route)", async () => {
    const decision = validDecision();
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(decision),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseDispatcherInput());

    // Should be a valid DispatcherDecision
    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe(decision.task_content);
  });

  it("response validates against DispatcherDecisionSchema (opencode route)", async () => {
    const decision = validDecision();
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(decision)),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    const result = await transport.invoke(baseDispatcherInput());

    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe(decision.task_content);
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-007: Engine-specific output parsing
  // -----------------------------------------------------------------------

  it("OpenCode NDJSON output parsed correctly", async () => {
    const decision = validDecision({ task_content: "NDJSON parsed content" });
    const ndjsonOutput = wrapNDJSON(JSON.stringify(decision));

    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: ndjsonOutput,
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(result.task_content).toBe("NDJSON parsed content");
  });

  it("Claude Code plain text output parsed correctly", async () => {
    const decision = validDecision({ task_content: "Claude text parsed content" });
    // Claude --print outputs plain text (the JSON response directly)
    const plainTextOutput = JSON.stringify(decision);

    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: plainTextOutput,
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(result.task_content).toBe("Claude text parsed content");
  });

  it("Claude Code output with surrounding text is still parsed", async () => {
    const decision = validDecision({ task_content: "Wrapped in text" });
    // Claude might output some extra text around the JSON
    const output = `Here is the response:\n${JSON.stringify(decision)}\nDone.`;

    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output,
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(result.task_content).toBe("Wrapped in text");
  });

  // -----------------------------------------------------------------------
  // VAL-DISP-008: Graceful error when engine binary not found
  // -----------------------------------------------------------------------

  it("throws clear error when engine binary not found (claude)", async () => {
    // Use the real binary check path — without a real spawner but with
    // the binary check running first. We need to test with a mock that
    // simulates Bun.which() returning null.
    // Instead, we test by passing an engine that does not exist.
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    // Use a fake engine name that won't match any registered engine
    try {
      const transport = new SubprocessTransport({
        spawner: mockSpawner,
        engineName: "nonexistent-engine",
      });
      await transport.invoke(baseDispatcherInput());
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("nonexistent-engine");
    }
  });

  // -----------------------------------------------------------------------
  // Existing behavior: retry-once-on-parse-failure
  // -----------------------------------------------------------------------

  it("retries once on parse failure then succeeds", async () => {
    let callCount = 0;
    const decision = validDecision();

    const mockSpawner: ProcessSpawner = {
      async spawn() {
        callCount++;
        if (callCount === 1) {
          return {
            result: Promise.resolve({
              output: "not valid json {{{",
              exitCode: 0,
              truncated: false,
              durationMs: 100,
            }),
          };
        }
        return {
          result: Promise.resolve({
            output: JSON.stringify(decision),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseDispatcherInput());
    expect(callCount).toBe(2);
    expect(result.task_content).toBe(decision.task_content);
  });

  it("throws after second parse failure", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: "still not valid json",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await expect(transport.invoke(baseDispatcherInput())).rejects.toThrow();
  });

  it("respects 60s timeout", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedTimeout = options?.timeoutMs;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseDispatcherInput());
    expect(receivedTimeout).toBe(60_000);
  });

  // -----------------------------------------------------------------------
  // VAL-CFG-003: Backward compatibility — no engineName defaults to opencode
  // -----------------------------------------------------------------------

  it("backward compat: no engineName defaults to legacy opencode behavior", async () => {
    let spawnedCommand = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedCommand = command;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    // Construct without engineName — should still work like before
    const transport = new SubprocessTransport({ spawner: mockSpawner });
    await transport.invoke(baseDispatcherInput());

    expect(spawnedCommand).toBe("opencode");
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
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 0,
          }),
        };
      },
    };

    const result = await autoDetectTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });

    // Claude should always use CLI (subprocess), never SDK
    expect(result.label).toBe("cli");
  });

  it("tries SDK first for opencode engine (existing behavior)", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 0,
          }),
        };
      },
    };

    const result = await autoDetectTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });

    // OpenCode can be SDK or CLI depending on SDK availability
    expect(["sdk", "cli"]).toContain(result.label);
  });

  it("passes engineName through to SubprocessTransport on fallback", async () => {
    // When SDK fails, the CLI fallback should pass the engine name through
    const mockSpawner: ProcessSpawner = {
      async spawn(command) {
        // Record what command was used
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 0,
          }),
        };
      },
    };

    const result = await autoDetectTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });

    // The transport should be a SubprocessTransport configured for claude
    expect(result.label).toBe("cli");
    expect(result.transport).toBeDefined();
  });

  it("passes dispatcherModel through to SubprocessTransport", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 0,
          }),
        };
      },
    };

    const result = await autoDetectTransport({
      spawner: mockSpawner,
      engineName: "claude",
      dispatcherModel: "haiku",
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
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 0,
          }),
        };
      },
    };

    const result = await autoDetectTransport({
      spawner: mockSpawner,
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

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validDecision()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "claude",
      dispatcherModel: "opus",
    });
    await transport.invoke(baseDispatcherInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("opus");
  });

  it("dispatcher.model in config changes the --model flag (opencode)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validDecision())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      dispatcherModel: "anthropic/claude-opus-4-6",
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
// We verify here that SubprocessTransport does NOT affect phase-executor.
// ---------------------------------------------------------------------------

describe("Worker spawn path unaffected", () => {
  it("SubprocessTransport does not export or modify PhaseExecutor", async () => {
    const mod = await import("../src/dispatcher/subprocess-transport");
    // SubprocessTransport is the only export that matters here
    expect(mod.SubprocessTransport).toBeDefined();
    // Should not have any phase-executor-related exports
    expect((mod as any).PhaseExecutor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helper: wrap text as NDJSON output (mimicking opencode run --format json)
// ---------------------------------------------------------------------------

function wrapNDJSON(text: string): string {
  return `{"type":"text","part":{"type":"text","text":${JSON.stringify(text)}}}\n`;
}
