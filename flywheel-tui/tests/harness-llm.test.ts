import { describe, expect, test } from "bun:test";
import { isNonRetryable, withRetry } from "../src/orchestration/engines/providers/harness/llm/retry.js";
import {
  ContextLengthExceededError,
  OutputLengthExceededError,
} from "../src/orchestration/engines/providers/harness/llm/types.js";
import {
  createModelsClient,
} from "../src/orchestration/engines/providers/harness/llm/models.js";
import { createClient } from "../src/orchestration/engines/providers/harness/llm/client-factory.js";

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
    });
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
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("does not retry on 400", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      });
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
      });
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
      });
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
      });
    } catch {
      // expected
    }
    expect(attempts).toBe(1);
  });

  test("honors retry-after header on 429", async () => {
    let attempts = 0;
    const start = Date.now();
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("rate limit"), {
          status: 429,
          headers: {
            get(name: string) {
              if (name === "retry-after") return "1";
              return null;
            },
          },
        });
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  test("throws after MAX_RETRIES exhausted", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw Object.assign(new Error("server error"), { status: 500 });
      }),
    ).rejects.toThrow("server error");
    expect(attempts).toBe(3);
  });
});

describe("createModelsClient", () => {
  test("detectProvider maps claude- to anthropic", () => {
    const client = createModelsClient();
    expect(client.detectProvider("claude-opus-4-6")).toBe("anthropic");
    expect(client.detectProvider("claude-sonnet-4-5-20250514")).toBe("anthropic");
    expect(client.detectProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
  });

  test("detectProvider maps gpt-/o-series/chatgpt- to openai", () => {
    const client = createModelsClient();
    expect(client.detectProvider("gpt-4o")).toBe("openai");
    expect(client.detectProvider("gpt-4o-mini")).toBe("openai");
    expect(client.detectProvider("o1")).toBe("openai");
    expect(client.detectProvider("o3-mini")).toBe("openai");
    expect(client.detectProvider("chatgpt-4o-latest")).toBe("openai");
  });

  test("detectProvider returns null for unknown prefix", () => {
    const client = createModelsClient();
    expect(client.detectProvider("llama-3")).toBeNull();
    expect(client.detectProvider("gemini-pro")).toBeNull();
  });
});

describe("createClient", () => {
  test("throws for unknown provider", () => {
    const modelsClient = createModelsClient();
    expect(() => createClient("llama-3-70b", modelsClient)).toThrow(
      "Cannot determine provider",
    );
  });

  test("throws when ANTHROPIC_API_KEY is missing", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const modelsClient = createModelsClient();
      expect(() => createClient("claude-opus-4-6", modelsClient)).toThrow(
        "ANTHROPIC_API_KEY",
      );
    } finally {
      if (original !== undefined) process.env["ANTHROPIC_API_KEY"] = original;
    }
  });

  test("throws when OPENAI_API_KEY is missing", () => {
    const original = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      const modelsClient = createModelsClient();
      expect(() => createClient("gpt-4o", modelsClient)).toThrow("OPENAI_API_KEY");
    } finally {
      if (original !== undefined) process.env["OPENAI_API_KEY"] = original;
    }
  });

  test("routes to anthropic adapter for claude models", () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    try {
      const modelsClient = createModelsClient();
      const client = createClient("claude-opus-4-6", modelsClient);
      expect(client.provider).toBe("anthropic");
    } finally {
      if (original !== undefined) {
        process.env["ANTHROPIC_API_KEY"] = original;
      } else {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
  });

  test("routes to openai adapter for gpt models", () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "test-key";
    try {
      const modelsClient = createModelsClient();
      const client = createClient("gpt-4o", modelsClient);
      expect(client.provider).toBe("openai");
    } finally {
      if (original !== undefined) {
        process.env["OPENAI_API_KEY"] = original;
      } else {
        delete process.env["OPENAI_API_KEY"];
      }
    }
  });
});
