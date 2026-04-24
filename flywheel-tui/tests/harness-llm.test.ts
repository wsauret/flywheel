import { describe, expect, test } from "bun:test";
import { isNonRetryable, withRetry } from "../src/orchestration/engines/providers/harness/llm/retry.js";
import {
  ContextLengthExceededError,
  OutputLengthExceededError,
} from "../src/orchestration/engines/providers/harness/llm/types.js";
import { createModelsClient } from "../src/orchestration/engines/providers/harness/llm/models.js";
import { detectModelFamily } from "../src/orchestration/engines/providers/harness/llm/model-family.js";
import { createClient } from "../src/orchestration/engines/providers/harness/llm/client-factory.js";
import { contextWindowForModel } from "../src/orchestration/engines/engine-context.js";

describe("isNonRetryable", () => {
  test("returns true for 400 status", () => {
    expect(isNonRetryable({ status: 400 })).toBe(true);
  });

  test("returns true for 401 status", () => {
    expect(isNonRetryable({ status: 401 })).toBe(true);
  });

  test("returns true for 403 status", () => {
    expect(isNonRetryable({ status: 403 })).toBe(true);
  });

  test("returns true for 404 status", () => {
    expect(isNonRetryable({ status: 404 })).toBe(true);
  });

  test("returns false for 429 status", () => {
    expect(isNonRetryable({ status: 429 })).toBe(false);
  });

  test("returns false for 500 status", () => {
    expect(isNonRetryable({ status: 500 })).toBe(false);
  });

  test("returns false for 502 status", () => {
    expect(isNonRetryable({ status: 502 })).toBe(false);
  });

  test("returns true for ContextLengthExceededError", () => {
    expect(isNonRetryable(new ContextLengthExceededError())).toBe(true);
  });

  test("returns true for OutputLengthExceededError", () => {
    expect(isNonRetryable(new OutputLengthExceededError())).toBe(true);
  });

  test("returns false for generic Error", () => {
    expect(isNonRetryable(new Error("network timeout"))).toBe(false);
  });

  test("returns false for non-object values", () => {
    expect(isNonRetryable(null)).toBe(false);
    expect(isNonRetryable(undefined)).toBe(false);
    expect(isNonRetryable("string")).toBe(false);
  });
});

const noSleep = { sleep: async () => {} };

describe("withRetry", () => {
  test("returns result on success", async () => {
    const result = await withRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  test("retries on 429 and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("rate limit"), { status: 429 });
      }
      return "ok";
    }, noSleep);
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("retries on 500 and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("server error"), { status: 500 });
      }
      return "ok";
    }, noSleep);
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry on 400", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      }, noSleep);
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  test("does not retry on 401", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      }, noSleep);
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  test("does not retry on 403", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }, noSleep);
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  test("does not retry on 404", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("not found"), { status: 404 });
      }, noSleep);
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  test("calls sleep with computed delay", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("rate limit"), { status: 429 });
      }
      return "ok";
    }, { sleep: async (ms) => { delays.push(ms) } });
    expect(result).toBe("ok");
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
  });

  test("throws after MAX_RETRIES exhausted", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("server error"), { status: 500 });
      }, noSleep),
    ).rejects.toThrow("server error");
    expect(attempts).toBe(3);
  });
});

describe("detectModelFamily", () => {
  test("maps claude- to anthropic", () => {
    expect(detectModelFamily("claude-opus-4-6")).toBe("anthropic");
    expect(detectModelFamily("claude-sonnet-4-5-20250514")).toBe("anthropic");
    expect(detectModelFamily("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  test("maps gpt-/o-series/chatgpt- to openai", () => {
    expect(detectModelFamily("gpt-4o")).toBe("openai");
    expect(detectModelFamily("gpt-4o-mini")).toBe("openai");
    expect(detectModelFamily("o1")).toBe("openai");
    expect(detectModelFamily("o3-mini")).toBe("openai");
    expect(detectModelFamily("chatgpt-4o-latest")).toBe("openai");
  });

  test("maps gemini- to google", () => {
    expect(detectModelFamily("gemini-2.5-pro")).toBe("google");
    expect(detectModelFamily("gemma-3")).toBe("google");
  });

  test("returns null for unknown prefixes", () => {
    expect(detectModelFamily("llama-3")).toBeNull();
  });
});

describe("contextWindowForModel", () => {
  test("maps current OpenAI fallback families to expected windows", () => {
    expect(contextWindowForModel("gpt-5.4")).toBe(128_000);
    expect(contextWindowForModel("gpt-5.3-codex")).toBe(128_000);
    expect(contextWindowForModel("chatgpt-4o-latest")).toBe(128_000);
    expect(contextWindowForModel("o3-mini")).toBe(200_000);
    expect(contextWindowForModel("gemini-2.5-pro")).toBe(1_000_000);
  });
});

describe("createClient", () => {
  const apiKeyAuth = {
    openaiAuth: "api_key" as const,
    anthropicApiKey: "test-anthropic-key",
    openaiApiKey: "test-openai-key",
  };
  const noKeysAuth = {
    openaiAuth: "api_key" as const,
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
  };

  test("throws for unknown model family", () => {
    const modelsClient = createModelsClient();
    expect(() => createClient("llama-3-70b", modelsClient, apiKeyAuth)).toThrow(
      "Cannot determine model family",
    );
  });

  test("throws when ANTHROPIC_API_KEY is missing", () => {
    const modelsClient = createModelsClient();
    const auth = { ...apiKeyAuth, anthropicApiKey: undefined };
    expect(() => createClient("claude-opus-4-6", modelsClient, auth)).toThrow(
      "ANTHROPIC_API_KEY",
    );
  });

  test("throws when OPENAI_API_KEY is missing", () => {
    const modelsClient = createModelsClient();
    const auth = { ...apiKeyAuth, openaiApiKey: undefined };
    expect(() => createClient("gpt-4o", modelsClient, auth)).toThrow("OPENAI_API_KEY");
  });

  test("throws when no access provider is configured for google models", () => {
    const modelsClient = createModelsClient();
    expect(() => createClient("gemini-2.5-pro", modelsClient, noKeysAuth)).toThrow("google models");
  });

  test("routes to anthropic access provider for claude models", () => {
    const modelsClient = createModelsClient();
    const client = createClient("claude-opus-4-6", modelsClient, apiKeyAuth);
    expect(client.accessProvider).toBe("anthropic_api");
    expect(client.modelFamily).toBe("anthropic");
  });

  test("routes to openai access provider for gpt models", () => {
    const modelsClient = createModelsClient();
    const client = createClient("gpt-4o", modelsClient, apiKeyAuth);
    expect(client.accessProvider).toBe("openai_api");
    expect(client.modelFamily).toBe("openai");
  });
});
