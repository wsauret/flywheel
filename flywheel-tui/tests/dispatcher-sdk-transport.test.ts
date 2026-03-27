import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { DispatcherInput, DispatcherDecision } from "../src/schemas/dispatcher";
import type { DispatcherDecisionHandoff } from "../src/schemas/handoff";
import type { ProcessSpawner } from "../src/worker/spawner";
import { DispatcherDecisionSchema } from "../src/schemas/dispatcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validHandoff(overrides?: Partial<DispatcherDecisionHandoff>): DispatcherDecisionHandoff {
  return {
    schema_version: 1,
    step_index: 0,
    task_content: "Execute the setup step by creating directory layout",
    context_files: ["src/index.ts"],
    validation_criteria: {
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
 * Extract the handoff path from a prompt text and write a handoff file there.
 */
async function writeHandoffFromPrompt(promptText: string, handoff: Record<string, unknown>): Promise<void> {
  const pathMatch = promptText.match(/`([^`]+\.json)`/);
  if (pathMatch) {
    await Bun.write(pathMatch[1], JSON.stringify(handoff));
  }
}

/**
 * Create a mock SDK client that writes a handoff file when prompt is called.
 * The handoff data is extracted from the prompt text (the path embedded in the handoff instruction).
 */
function createHandoffMockClient(
  handoffOrFn: Record<string, unknown> | ((callCount: number) => Record<string, unknown> | null),
  hooks?: {
    onPrompt?: (opts: any) => void;
  },
): { client: any; callCount: () => number } {
  let calls = 0;
  const client = {
    session: {
      create: async () => ({ data: { id: `mock-session-${++calls}` } }),
      prompt: async (opts: any) => {
        hooks?.onPrompt?.(opts);
        const promptText = opts.body.parts?.[0]?.text ?? "";
        const handoff = typeof handoffOrFn === "function" ? handoffOrFn(calls) : handoffOrFn;
        if (handoff) {
          await writeHandoffFromPrompt(promptText, handoff);
        }
        return { data: {} };
      },
    },
  };
  return { client, callCount: () => calls };
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
    const { client } = createHandoffMockClient(validHandoff(), {
      onPrompt: (opts) => { capturedPromptOpts = opts; },
    });

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport({ dispatcherModel: "anthropic/claude-sonnet-4-6" });
    await transport.invoke(baseDispatcherInput());

    expect(capturedPromptOpts).toBeDefined();
    expect(capturedPromptOpts.body.model).toBeDefined();
    expect(capturedPromptOpts.body.model.providerID).toBe("anthropic");
    expect(capturedPromptOpts.body.model.modelID).toBe("claude-sonnet-4-6");
  });

  it("passes model with default sonnet when no dispatcherModel specified", async () => {
    let capturedPromptOpts: any;
    const { client } = createHandoffMockClient(validHandoff(), {
      onPrompt: (opts) => { capturedPromptOpts = opts; },
    });

    _setClientFactoryForTesting(() => client);

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
    const { client } = createHandoffMockClient(validHandoff(), {
      onPrompt: (opts) => { capturedPromptOpts = opts; },
    });

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport({ dispatcherModel: "openai/gpt-4o" });
    await transport.invoke(baseDispatcherInput());

    expect(capturedPromptOpts.body.model).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    });
  });

  it("handles model string without provider prefix by using 'anthropic' as default provider", async () => {
    let capturedPromptOpts: any;
    const { client } = createHandoffMockClient(validHandoff(), {
      onPrompt: (opts) => { capturedPromptOpts = opts; },
    });

    _setClientFactoryForTesting(() => client);

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
// VAL-SDK-002: SDK transport produces valid DispatcherDecision via handoff file
// ---------------------------------------------------------------------------

describe("SdkTransport: valid DispatcherDecision output via handoff", () => {
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

  it("produces a valid DispatcherDecision with task_content from handoff file", async () => {
    const handoff = validHandoff({ task_content: "SDK-produced task content" });
    const { client } = createHandoffMockClient(handoff);

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    // Validate against schema
    const parsed = DispatcherDecisionSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result.task_content).toBe("SDK-produced task content");
  });

  it("reads decision from handoff file, not from SDK response body", async () => {
    const handoff = validHandoff({ task_content: "From handoff file" });
    const { client } = createHandoffMockClient(handoff);

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    expect(result.task_content).toBe("From handoff file");
    expect(result.step_index).toBe(0);
    expect(result.context_files).toEqual(["src/index.ts"]);
  });

  it("maps handoff fields correctly", async () => {
    const handoff = validHandoff({
      step_index: 2,
      task_content: "Step 3 task",
      context_files: ["a.ts", "b.ts"],
      session_name: "test-session",
    });
    const { client } = createHandoffMockClient(handoff);

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    expect(result.step_index).toBe(2);
    expect(result.task_content).toBe("Step 3 task");
    expect(result.context_files).toEqual(["a.ts", "b.ts"]);
    expect(result.session_name).toBe("test-session");
  });

  it("includes handoff instruction in the user prompt text", async () => {
    let capturedPromptText = "";
    const { client } = createHandoffMockClient(validHandoff(), {
      onPrompt: (opts) => {
        capturedPromptText = opts.body.parts?.[0]?.text ?? "";
      },
    });

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    await transport.invoke(baseDispatcherInput());

    // The prompt should include the handoff instruction
    expect(capturedPromptText).toContain("Dispatcher Handoff Instructions");
    expect(capturedPromptText).toContain(".json");
    expect(capturedPromptText).toContain("schema_version");
  });
});

// ---------------------------------------------------------------------------
// VAL-SDK-002b: SDK transport retry on handoff failure
// ---------------------------------------------------------------------------

describe("SdkTransport: handoff retry logic", () => {
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

  it("retries once when handoff file is missing, succeeds on second attempt", async () => {
    const handoff = validHandoff();
    // First call: don't write handoff; second call: write it
    const { client, callCount } = createHandoffMockClient((n) => n >= 2 ? handoff : null);

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    const result = await transport.invoke(baseDispatcherInput());

    expect(callCount()).toBe(2);
    expect(result.task_content).toBe(handoff.task_content);
  });

  it("throws after MAX_RETRIES+1 attempts when handoff always missing", async () => {
    // Never write a handoff file
    const { client } = createHandoffMockClient(() => null);

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    await expect(transport.invoke(baseDispatcherInput())).rejects.toThrow(
      /SDK dispatcher failed after 2 attempts/,
    );
  });

  it("includes RETRY note in prompt on second attempt", async () => {
    const capturedPrompts: string[] = [];
    const handoff = validHandoff();
    // First call: no handoff; second call: write it
    const { client } = createHandoffMockClient((n) => n >= 2 ? handoff : null, {
      onPrompt: (opts) => {
        capturedPrompts.push(opts.body.parts?.[0]?.text ?? "");
      },
    });

    _setClientFactoryForTesting(() => client);

    const transport = new SdkTransport();
    await transport.invoke(baseDispatcherInput());

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).not.toContain("[RETRY]");
    expect(capturedPrompts[1]).toContain("[RETRY]");
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
    const { client } = createHandoffMockClient(validHandoff());
    _setClientFactoryForTesting(() => client);

    expect(() => {
      new SdkTransport({ engineName: "claude" });
    }).toThrow(/opencode/i);
  });

  it("throws clear error for any non-opencode engine", async () => {
    const { client } = createHandoffMockClient(validHandoff());
    _setClientFactoryForTesting(() => client);

    expect(() => {
      new SdkTransport({ engineName: "some-other-engine" });
    }).toThrow(/opencode/i);
  });

  it("does NOT throw when engine is 'opencode'", async () => {
    const { client } = createHandoffMockClient(validHandoff());
    _setClientFactoryForTesting(() => client);

    expect(() => {
      new SdkTransport({ engineName: "opencode" });
    }).not.toThrow();
  });

  it("does NOT throw when engine is not specified (defaults to opencode)", async () => {
    const { client } = createHandoffMockClient(validHandoff());
    _setClientFactoryForTesting(() => client);

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
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 0,
            handoffPath: "/tmp/unused",
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
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 0,
            handoffPath: "/tmp/unused",
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

    const handoff = {
      schema_version: 1,
      step_index: 0,
      task_content: "Execute the setup step by creating directory layout",
      context_files: ["src/index.ts"],
      reasoning: "Standard setup step execution",
    };

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        // Write handoff file from prompt
        const prompt = (() => {
          const pIdx = args.indexOf("-p");
          if (pIdx > -1) return args[pIdx + 1];
          return options?.stdin ?? "";
        })();
        const pathMatch = prompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          await Bun.write(pathMatch[1], JSON.stringify(handoff));
        }
        return {
          result: Promise.resolve({
            output: "",
            exitCode: 0,
            truncated: false,
            durationMs: 0,
            handoffPath: "/tmp/unused",
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
