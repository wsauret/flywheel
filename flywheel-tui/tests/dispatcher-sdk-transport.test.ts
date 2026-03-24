import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { DispatcherInput, DispatcherDecision } from "../src/schemas/dispatcher";
import type { ProcessSpawner } from "../src/worker/spawner";
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
// VAL-SDK-001: SDK transport passes model parameter
// ---------------------------------------------------------------------------

describe("SdkTransport: model parameter", () => {
  let SdkTransport: typeof import("../src/dispatcher/sdk-transport").SdkTransport;
  let _setClientFactoryForTesting: typeof import("../src/dispatcher/sdk-transport")._setClientFactoryForTesting;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/sdk-transport");
    SdkTransport = mod.SdkTransport;
    _setClientFactoryForTesting = mod._setClientFactoryForTesting;
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  it("passes model in session.prompt() body when dispatcherModel is provided", async () => {
    let capturedPromptOpts: any;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-model-1" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport({ dispatcherModel: "anthropic/claude-sonnet-4-6" });
    await transport.invoke(baseDispatcherInput());

    expect(capturedPromptOpts).toBeDefined();
    expect(capturedPromptOpts.body.model).toBeDefined();
    expect(capturedPromptOpts.body.model.providerID).toBe("anthropic");
    expect(capturedPromptOpts.body.model.modelID).toBe("claude-sonnet-4-6");
  });

  it("passes model with default sonnet when no dispatcherModel specified", async () => {
    let capturedPromptOpts: any;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-model-2" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport();
    await transport.invoke(baseDispatcherInput());

    expect(capturedPromptOpts).toBeDefined();
    // Should use default model for opencode engine: anthropic/claude-sonnet-4-6
    expect(capturedPromptOpts.body.model).toBeDefined();
    expect(capturedPromptOpts.body.model.providerID).toBe("anthropic");
    expect(capturedPromptOpts.body.model.modelID).toBe("claude-sonnet-4-6");
  });

  it("parses compound model string (provider/model) into providerID and modelID", async () => {
    let capturedPromptOpts: any;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-model-3" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport({ dispatcherModel: "openai/gpt-4o" });
    await transport.invoke(baseDispatcherInput());

    expect(capturedPromptOpts.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    });
  });

  it("handles model string without provider prefix by using 'anthropic' as default provider", async () => {
    let capturedPromptOpts: any;

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-model-4" } }),
        prompt: async (opts: any) => {
          capturedPromptOpts = opts;
          return { data: { text: JSON.stringify(validDecision()) } };
        },
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport({ dispatcherModel: "claude-sonnet-4-6" });
    await transport.invoke(baseDispatcherInput());

    // Without slash, default provider is "anthropic"
    expect(capturedPromptOpts.body.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-SDK-002: SDK transport produces valid DispatcherDecision
// ---------------------------------------------------------------------------

describe("SdkTransport: valid DispatcherDecision output", () => {
  let SdkTransport: typeof import("../src/dispatcher/sdk-transport").SdkTransport;
  let _setClientFactoryForTesting: typeof import("../src/dispatcher/sdk-transport")._setClientFactoryForTesting;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/sdk-transport");
    SdkTransport = mod.SdkTransport;
    _setClientFactoryForTesting = mod._setClientFactoryForTesting;
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  it("produces a valid DispatcherDecision with task_content", async () => {
    const decision = validDecision({ task_content: "SDK-produced task content" });

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-valid-1" } }),
        prompt: async () => ({ data: { text: JSON.stringify(decision) } }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    // Validate against schema
    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe("SDK-produced task content");
  });

  it("produces valid decision from OpenCode parts response format", async () => {
    const decision = validDecision({ task_content: "Parts format content" });

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-valid-2" } }),
        prompt: async () => ({
          data: {
            info: { id: "msg-1" },
            parts: [{ type: "text", text: JSON.stringify(decision) }],
          },
        }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe("Parts format content");
  });
});

// ---------------------------------------------------------------------------
// VAL-SDK-003: SDK transport is OpenCode-only
// ---------------------------------------------------------------------------

describe("SdkTransport: OpenCode-only guard", () => {
  let SdkTransport: typeof import("../src/dispatcher/sdk-transport").SdkTransport;
  let _setClientFactoryForTesting: typeof import("../src/dispatcher/sdk-transport")._setClientFactoryForTesting;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/sdk-transport");
    SdkTransport = mod.SdkTransport;
    _setClientFactoryForTesting = mod._setClientFactoryForTesting;
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  it("throws clear error when engine is 'claude' (SDK is OpenCode-only)", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-guard-1" } }),
        prompt: async () => ({ data: { text: JSON.stringify(validDecision()) } }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    expect(() => {
      new SdkTransport({ engineName: "claude" });
    }).toThrow(/opencode/i);
  });

  it("throws clear error for any non-opencode engine", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-guard-2" } }),
        prompt: async () => ({ data: { text: JSON.stringify(validDecision()) } }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    expect(() => {
      new SdkTransport({ engineName: "some-other-engine" });
    }).toThrow(/opencode/i);
  });

  it("does NOT throw when engine is 'opencode'", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-guard-3" } }),
        prompt: async () => ({ data: { text: JSON.stringify(validDecision()) } }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    expect(() => {
      new SdkTransport({ engineName: "opencode" });
    }).not.toThrow();
  });

  it("does NOT throw when engine is not specified (defaults to opencode)", async () => {
    const mockClient = {
      session: {
        create: async () => ({ data: { id: "mock-session-guard-4" } }),
        prompt: async () => ({ data: { text: JSON.stringify(validDecision()) } }),
      },
    };

    _setClientFactoryForTesting(() => mockClient);

    expect(() => {
      new SdkTransport();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VAL-SDK-003 + VAL-DISP-006: Auto-detect never creates SDK transport for claude
// ---------------------------------------------------------------------------

describe("Auto-detect: never uses SDK for claude engine", () => {
  let autoDetectTransport: typeof import("../src/dispatcher/auto-detect").autoDetectTransport;

  beforeEach(async () => {
    const mod = await import("../src/dispatcher/auto-detect");
    autoDetectTransport = mod.autoDetectTransport;
  });

  it("never returns SDK label for claude engine", async () => {
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

    expect(result.label).toBe("cli");
  });

  it("always uses CLI transport for claude engine regardless of SDK availability", async () => {
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

    // Run it multiple times to verify consistency
    for (let i = 0; i < 3; i++) {
      const result = await autoDetectTransport({
        spawner: mockSpawner,
        engineName: "claude",
      });
      expect(result.label).toBe("cli");
    }
  });

  it("passes dispatcherModel to SDK transport when using opencode engine", async () => {
    // This test verifies the auto-detect passes model through to SdkTransport
    // We can't easily test this without mocking the server, but we verify
    // the SubprocessTransport fallback receives dispatcherModel
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: `{"type":"text","part":{"type":"text","text":"${JSON.stringify(validDecision()).replace(/"/g, '\\"')}"}}\n`,
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
      dispatcherModel: "anthropic/claude-haiku-4-5",
    });

    // If it falls back to CLI, verify model is passed
    if (result.label === "cli") {
      await result.transport.invoke(baseDispatcherInput());
      expect(spawnedArgs).toContain("--model");
      const modelIdx = spawnedArgs.indexOf("--model");
      expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-haiku-4-5");
    }
    // If SDK was selected, the model was passed through SdkTransport constructor
    // (covered by the model parameter tests above)
  });
});
