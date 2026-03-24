import { describe, it, expect, beforeEach } from "bun:test";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import { EvaluatorResultSchema } from "../src/schemas/evaluator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEvaluatorResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All validation criteria met",
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
    validation_criteria: "Tests must pass",
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
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

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
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
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
      async spawn(command, args) {
        spawnedCommand = command;
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    // Should use engine-built command, not hardcoded "opencode run --format json"
    expect(spawnedCommand).not.toBe("opencode");
    expect(spawnedCommand).toBe("claude");
  });

  // -----------------------------------------------------------------------
  // VAL-EVAL-002: Evaluator optimization flags
  // -----------------------------------------------------------------------

  it("Claude route includes all dispatcher optimization flags (tools disabled, model, etc.)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    // Same optimization flags as dispatcher
    expect(spawnedArgs).toContain("--print");
    expect(spawnedArgs).toContain("--dangerously-skip-permissions");
    expect(spawnedArgs).toContain("--no-session-persistence");
    expect(spawnedArgs).toContain("--tools");
    const toolsIdx = spawnedArgs.indexOf("--tools");
    expect(spawnedArgs[toolsIdx + 1]).toBe(""); // tools disabled
    expect(spawnedArgs).toContain("--model");
    expect(spawnedArgs).toContain("--effort");
    const effortIdx = spawnedArgs.indexOf("--effort");
    expect(spawnedArgs[effortIdx + 1]).toBe("low");
  });

  it("Claude route uses --system-prompt for evaluator prompt (separate for caching)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--system-prompt");
    const sysIdx = spawnedArgs.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    // The system prompt should contain evaluator-specific instructions
    expect(spawnedArgs[sysIdx + 1]).toBeTruthy();
    expect(spawnedArgs[sysIdx + 1]).toContain("evaluator");
  });

  it("Claude route passes evaluator input via -p flag (not stdin)", async () => {
    let spawnedArgs: string[] = [];
    let receivedStdin: string | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("-p");
    // Claude route should NOT use stdin for prompt delivery
    expect(receivedStdin).toBeUndefined();
  });

  it("OpenCode route passes --model flag", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--model");
  });

  it("OpenCode route passes evaluator input via stdin", async () => {
    let receivedStdin = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedStdin = options?.stdin ?? "";
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    await transport.invoke(baseEvaluatorInput());

    // OpenCode uses stdin for prompt delivery
    expect(receivedStdin).toBeTruthy();
    expect(receivedStdin).toContain("evaluator");
  });

  // -----------------------------------------------------------------------
  // Default model behavior
  // -----------------------------------------------------------------------

  it("defaults to 'sonnet' model for claude when not configured", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      // No evaluatorModel — should use engine default
    });
    await transport.invoke(baseEvaluatorInput());

    const modelIdx = spawnedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[modelIdx + 1]).toBe("sonnet");
  });

  it("defaults to 'anthropic/claude-sonnet-4-6' model for opencode when not configured", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
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
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
      evaluatorModel: "haiku",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedArgs).toContain("--model");
    const modelIdx = spawnedArgs.indexOf("--model");
    expect(spawnedArgs[modelIdx + 1]).toBe("haiku");
  });

  it("evaluatorModel flows through to --model CLI flag (opencode)", async () => {
    let spawnedArgs: string[] = [];

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedArgs = args;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
      evaluatorModel: "anthropic/claude-haiku-4-5",
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
          }),
        };
      },
    };

    try {
      new SubprocessEvaluatorTransport({
        spawner: mockSpawner,
        engineName: "nonexistent-engine",
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

  it("OpenCode NDJSON output parsed correctly", async () => {
    const result = validEvaluatorResult({ reasoning: "NDJSON parsed evaluator result" });
    const ndjsonOutput = wrapNDJSON(JSON.stringify(result));

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(evalResult.reasoning).toBe("NDJSON parsed evaluator result");
  });

  it("Claude Code plain text output parsed correctly", async () => {
    const result = validEvaluatorResult({ reasoning: "Claude text parsed evaluator result" });
    const plainTextOutput = JSON.stringify(result);

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(evalResult.reasoning).toBe("Claude text parsed evaluator result");
  });

  it("Claude Code output with surrounding text is still parsed", async () => {
    const result = validEvaluatorResult({ reasoning: "Wrapped evaluator result" });
    const output = `Here is my evaluation:\n${JSON.stringify(result)}\nDone.`;

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(evalResult.reasoning).toBe("Wrapped evaluator result");
  });

  it("response validates against EvaluatorResultSchema (claude route)", async () => {
    const result = validEvaluatorResult();
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: JSON.stringify(result),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());

    const parsed = EvaluatorResultSchema.safeParse(evalResult);
    expect(parsed.success).toBe(true);
  });

  it("response validates against EvaluatorResultSchema (opencode route)", async () => {
    const result = validEvaluatorResult();
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(result)),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "opencode",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());

    const parsed = EvaluatorResultSchema.safeParse(evalResult);
    expect(parsed.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Existing behavior preserved
  // -----------------------------------------------------------------------

  it("retries once on parse failure then succeeds", async () => {
    let callCount = 0;
    const result = validEvaluatorResult();

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
            output: JSON.stringify(result),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const evalResult = await transport.invoke(baseEvaluatorInput());
    expect(callCount).toBe(2);
    expect(evalResult.passed).toBe(true);
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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await expect(transport.invoke(baseEvaluatorInput())).rejects.toThrow();
  });

  it("respects 30s timeout", async () => {
    let receivedTimeout: number | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        receivedTimeout = options?.timeoutMs;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());
    expect(receivedTimeout).toBe(30_000);
  });

  it("backward compat: no engineName defaults to legacy opencode behavior", async () => {
    let spawnedCommand = "";

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args) {
        spawnedCommand = command;
        return {
          result: Promise.resolve({
            output: wrapNDJSON(JSON.stringify(validEvaluatorResult())),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    // Construct without engineName — should still work like before
    const transport = new SubprocessEvaluatorTransport({ spawner: mockSpawner });
    await transport.invoke(baseEvaluatorInput());

    expect(spawnedCommand).toBe("opencode");
  });

  it("applies env filter via createEnvFilter()", async () => {
    let receivedEnv: Record<string, string> | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(_command, _args, options) {
        receivedEnv = options?.env;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
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

  it("evaluator prompt contains evaluator-specific content (not dispatcher content)", async () => {
    let spawnedArgs: string[] = [];
    let receivedStdin: string | undefined;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        spawnedArgs = args;
        receivedStdin = options?.stdin;
        return {
          result: Promise.resolve({
            output: JSON.stringify(validEvaluatorResult()),
            exitCode: 0,
            truncated: false,
            durationMs: 100,
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    // For Claude route, prompt is in -p flag
    const pIdx = spawnedArgs.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    const prompt = spawnedArgs[pIdx + 1];
    // Should contain evaluator-specific content
    expect(prompt).toContain("Worker Output");
    expect(prompt).toContain("Validation Criteria");
    // Should NOT contain dispatcher-specific content
    expect(prompt).not.toContain("prompt engineering specialist");
  });
});
