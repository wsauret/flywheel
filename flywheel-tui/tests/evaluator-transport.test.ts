import { describe, it, expect, beforeEach } from "bun:test";
import type { EvaluatorInput, EvaluatorResult } from "../src/evaluator/schemas";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import { EvaluatorResultSchema } from "../src/evaluator/schemas";

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

/**
 * Wrap text as NDJSON output (mimicking opencode run --format json)
 */
function wrapNDJSON(text: string): string {
  return `{"type":"text","part":{"type":"text","text":${JSON.stringify(text)}}}\n`;
}

/**
 * Extract the handoff path from an evaluator prompt and write a verdict file.
 * The evaluator transport now reads verdicts from handoff files, not stdout.
 */
async function writeVerdictFromPrompt(prompt: string, verdict: Record<string, unknown>): Promise<void> {
  const pathMatch = prompt.match(/`([^`]+\.json)`/);
  if (pathMatch) {
    await Bun.write(pathMatch[1], JSON.stringify(verdict));
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
 * Create a mock spawner that auto-writes a verdict handoff file.
 * Wraps any existing spawn function to also extract the handoff path from
 * the prompt and write the verdict JSON file.
 *
 * @param verdictOrFn - static verdict object, or a function(callCount) => verdict | null.
 *   When null, no verdict is written (simulating handoff-missing).
 * @param hooks - optional hooks for capturing args, env, stdin, etc.
 */
function createHandoffSpawner(
  verdictOrFn: Record<string, unknown> | ((callCount: number) => Record<string, unknown> | null),
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
      const verdict = typeof verdictOrFn === "function" ? verdictOrFn(calls) : verdictOrFn;
      if (verdict) {
        await writeVerdictFromPrompt(prompt, verdict);
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
// SubprocessEvaluatorTransport — engine-aware tests
// ---------------------------------------------------------------------------

describe("SubprocessEvaluatorTransport: engine-aware command building", () => {
  let SubprocessEvaluatorTransport: typeof import("../src/evaluator/subprocess-transport").SubprocessEvaluatorTransport;

  beforeEach(async () => {
    const mod = await import("../src/evaluator/subprocess-transport");
    SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;
  });

  // -----------------------------------------------------------------------
  // VAL-EVAL-001: Engine-aware evaluator transport
  // -----------------------------------------------------------------------

  it("spawns 'claude' engine when engineName is 'claude'", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedCommand).toBe("claude");
    expect(spawnedArgs).toContain("-p");
    expect(spawnedArgs).toContain("--tools");
    expect(spawnedArgs).toContain("--no-session-persistence");
    // No --effort flag — agent needs full reasoning for investigation
    expect(spawnedArgs).not.toContain("--effort");
  });

  it("spawns 'opencode' engine when engineName is 'opencode'", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedCommand).toBe("opencode");
    expect(spawnedArgs).toContain("run");
    expect(spawnedArgs).toContain("--format");
    expect(spawnedArgs).toContain("json");
  });

  it("uses engine registry for command building (not hardcoded)", async () => {
    let spawnedCommand = "";
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    // Should use engine-built command, not hardcoded "opencode run --format json"
    expect(spawnedCommand).not.toBe("opencode");
    expect(spawnedCommand).toBe("claude");
  });

  // -----------------------------------------------------------------------
  // VAL-EVAL-002: Evaluator optimization flags
  // -----------------------------------------------------------------------

  it("Claude route includes evaluator flags (tools for investigation, model, no session persistence)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    // Agent-based evaluator: -p for one-shot, investigation tools, no session persistence
    expect(spawnedArgs).toContain("-p");
    expect(spawnedArgs).toContain("--dangerously-skip-permissions");
    expect(spawnedArgs).toContain("--no-session-persistence");
    expect(spawnedArgs).toContain("--tools");
    const toolsIdx = spawnedArgs.indexOf("--tools");
    expect(spawnedArgs[toolsIdx + 1]).toBe("Read,Bash,Write,Grep,Glob");
    expect(spawnedArgs).toContain("--model");
    // No --effort flag — agent needs full reasoning for investigation
    expect(spawnedArgs).not.toContain("--effort");
  });

  it("Claude route uses --system-prompt for evaluator prompt (separate for caching)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--system-prompt");
    const sysIdx = spawnedArgs.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    // The system prompt should contain verification agent instructions
    expect(spawnedArgs[sysIdx + 1]).toBeTruthy();
    expect(spawnedArgs[sysIdx + 1]).toContain("verification agent");
  });

  it("Claude route passes evaluator input via -p flag (not stdin)", async () => {
    let spawnedArgs: string[] = [];
    let receivedStdin: string | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("-p");
    // Claude route should NOT use stdin for prompt delivery
    expect(receivedStdin).toBeUndefined();
  });

  it("OpenCode route passes --model flag", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--model");
  });

  it("OpenCode route passes evaluator input via stdin", async () => {
    let receivedStdin = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedStdin = options?.stdin ?? "";
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    // OpenCode uses stdin for prompt delivery
    expect(receivedStdin).toBeTruthy();
    expect(receivedStdin).toContain("verification agent");
  });

  // -----------------------------------------------------------------------
  // Default model behavior
  // -----------------------------------------------------------------------

  it("defaults to 'sonnet' model for claude when not configured", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      // No evaluatorModel — should use engine default
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("sonnet");
  });

  it("defaults to 'anthropic/claude-sonnet-4-6' model for opencode when not configured", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  // -----------------------------------------------------------------------
  // Config model override
  // -----------------------------------------------------------------------

  it("evaluatorModel flows through to --model CLI flag (claude)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      evaluatorModel: "haiku",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  it("evaluatorModel flows through to --model CLI flag (opencode)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      evaluatorModel: "anthropic/claude-haiku-4-5",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("anthropic/claude-haiku-4-5");
  });

  // -----------------------------------------------------------------------
  // Engine binary not found → clear error
  // -----------------------------------------------------------------------

  it("throws clear error when engine binary not found (unknown engine)", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    try {
      new SubprocessEvaluatorTransport({
        spawner: mockSpawner,
        engineName: "nonexistent-engine",
      sessionId: "test-session",
      baseDir: "/tmp/test",
      });
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("nonexistent-engine");
    }
  });

  // -----------------------------------------------------------------------
  // Output parsing: both engines
  // -----------------------------------------------------------------------

  it("verdict read from handoff file (opencode route)", async () => {
    const verdict = validEvaluatorResult({ reasoning: "Handoff-based verdict (opencode)" });
    const { spawner } = createHandoffSpawner(verdict);

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(evalResult.reasoning).toBe("Handoff-based verdict (opencode)");
  });

  it("verdict read from handoff file (claude route)", async () => {
    const verdict = validEvaluatorResult({ reasoning: "Handoff-based verdict (claude)" });
    const { spawner } = createHandoffSpawner(verdict);

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(evalResult.reasoning).toBe("Handoff-based verdict (claude)");
  });

  it("response validates against EvaluatorResultSchema (claude route)", async () => {
    const { spawner } = createHandoffSpawner(validEvaluatorResult());

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());

    const parsed = EvaluatorResultSchema.safeParse(evalResult);
    expect(parsed.success).toBe(true);
  });

  it("response validates against EvaluatorResultSchema (opencode route)", async () => {
    const { spawner } = createHandoffSpawner(validEvaluatorResult());

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "opencode",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());

    const parsed = EvaluatorResultSchema.safeParse(evalResult);
    expect(parsed.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Existing behavior preserved (handoff-based retry)
  // -----------------------------------------------------------------------

  it("retries once on handoff missing then succeeds", async () => {
    const verdict = validEvaluatorResult();
    // First call: no verdict file; second call: verdict written
    const { spawner, callCount } = createHandoffSpawner((n) => n >= 2 ? verdict : null);

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(callCount()).toBe(2);
    expect(evalResult.passed).toBe(true);
  });

  it("throws after both handoff reads fail", async () => {
    // Never write a verdict file
    const { spawner } = createHandoffSpawner(() => null);

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await expect(transport.invoke(baseEvaluatorInput())).rejects.toThrow();
  });

  it("respects 60s timeout (agent needs time for investigation)", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedTimeout = options?.timeoutMs;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    expect(receivedTimeout).toBe(60_000);
  });

  it("backward compat: no engineName defaults to legacy opencode behavior", async () => {
    let spawnedCommand = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedCommand = command;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    // Construct without engineName — should still work like before
    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner, sessionId: "test-session", baseDir: "/tmp/test" });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedCommand).toBe("opencode");
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(_command, _args, options) {
        receivedEnv = options?.env;
        await writeVerdictFromPrompt(extractPromptFromArgs(_args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(receivedEnv).toBeDefined();
    if (receivedEnv) {
      const keys = Object.keys(receivedEnv);
      for (const key of keys) {
        expect(key).not.toMatch(/_API_KEY$/);
        expect(key).not.toMatch(/_SECRET_KEY$/);
        expect(key).not.toMatch(/_SECRET$/);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Evaluator uses its OWN prompt (not dispatcher's system prompt)
  // -----------------------------------------------------------------------

  it("buildPrompt includes all 6 EvaluatorResultSchema fields in instructions", async () => {
    let capturedPrompt = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        // For Claude, prompt is in -p flag
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) {
          capturedPrompt = args[pIdx + 1];
        }
        // For OpenCode, prompt is in stdin
        if (options?.stdin) {
          capturedPrompt = options.stdin;
        }
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    // All 6 fields from EvaluatorResultSchema must be mentioned in the prompt
    expect(capturedPrompt).toContain("passed");
    expect(capturedPrompt).toContain("reasoning");
    expect(capturedPrompt).toContain("suggestions");
    expect(capturedPrompt).toContain("confidence");
    expect(capturedPrompt).toContain("feedback");
    expect(capturedPrompt).toContain("files_to_review");

    // Confidence must be explicitly specified as 0.0-1.0
    expect(capturedPrompt).toMatch(/0\.0.*1\.0/);
  });

  it("evaluator prompt contains evaluator-specific content (not dispatcher content)", async () => {
    let spawnedArgs: string[] = [];
    let receivedStdin: string | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    // For Claude route, prompt is in -p flag
    const pIdx = spawnedArgs.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    const prompt = spawnedArgs[pIdx + 1];
    // Should contain evaluator-specific content (verdict, pass/fail)
    expect(prompt).toContain("Verdict");
    expect(prompt).toContain("passed");
    // Should NOT contain dispatcher-specific content
    expect(prompt).not.toContain("prompt engineering specialist");
  });
});

// ---------------------------------------------------------------------------
// VAL-PROMPT-003: Evaluator prompt optimized for clarity
// ---------------------------------------------------------------------------

describe("SubprocessEvaluatorTransport: prompt optimization (VAL-PROMPT-003)", () => {
  let SubprocessEvaluatorTransport: typeof import("../src/evaluator/subprocess-transport").SubprocessEvaluatorTransport;

  /** Helper to capture the prompt text from the -p flag (Claude engine route). */
  function createPromptCapturingSpawner(): { spawner: ProcessSpawner; getPrompt: () => string } {
    let capturedPrompt = "";
    const spawner: ProcessSpawner = {
      async spawn(command, args, options) {
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) {
          capturedPrompt = args[pIdx + 1];
        }
        if (options?.stdin) {
          capturedPrompt = options.stdin;
        }
        await writeVerdictFromPrompt(extractPromptFromArgs(args, options), validEvaluatorResult());
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };
    return { spawner, getPrompt: () => capturedPrompt };
  }

  beforeEach(async () => {
    const mod = await import("../src/evaluator/subprocess-transport");
    SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;
  });

  // -----------------------------------------------------------------------
  // 1. No duplicate role framing between system prompt and buildPrompt()
  // -----------------------------------------------------------------------

  it("buildPrompt() does NOT start with 'You are an evaluator' (role set via system prompt only)", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    const prompt = getPrompt();
    // The prompt should NOT contain the role framing sentence — it's in the system prompt
    expect(prompt).not.toContain("You are an evaluator");
  });

  // -----------------------------------------------------------------------
  // 2. context_files section removed or changed to informational-only
  // -----------------------------------------------------------------------

  it("context_files section is not included in the lean prompt", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput({ context_files: ["src/foo.ts", "src/bar.ts"] }));

    const prompt = getPrompt();
    // Lean prompt omits context_files to save tokens and time
    expect(prompt).not.toContain("## Context Files");
    expect(prompt).not.toContain("Worker Had Access To");
  });

  it("context_files informational section is omitted when no context files provided", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput({ context_files: [] }));

    const prompt = getPrompt();
    expect(prompt).not.toContain("worker was given access to these files");
  });

  // -----------------------------------------------------------------------
  // 3. duration_seconds surfaced in the prompt
  // -----------------------------------------------------------------------

  it("lean prompt omits timing section to save tokens", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput({ duration_seconds: 45 }));

    const prompt = getPrompt();
    // Timing removed from lean prompt — evaluator doesn't need it
    expect(prompt).not.toContain("## Timing");
  });

  // -----------------------------------------------------------------------
  // 4. Pass/fail threshold guidance added
  // -----------------------------------------------------------------------

  it("includes pass/fail guidance biased toward passing", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    const prompt = getPrompt();
    // Should contain lean guidance about passing by default
    expect(prompt).toContain("hard evidence");
    expect(prompt).toContain("pass with suggestions");
  });

  it("includes verdict JSON schema with confidence field", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());

    const prompt = getPrompt();
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("0.9");
  });
});
