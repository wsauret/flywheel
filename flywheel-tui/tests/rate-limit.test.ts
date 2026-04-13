import { describe, it, expect } from "bun:test";
import {
  detectRateLimit,
  type RateLimitDetectionInput,
} from "../src/orchestration/engines/subprocess/rate-limit";

describe("detectRateLimit", () => {

  // -----------------------------------------------------------------------
  // Common patterns (agent-agnostic)
  // -----------------------------------------------------------------------

  describe("common patterns", () => {
    it('detects "rate limit" in stderr', () => {
      const result = detectRateLimit({ stderr: "Error: rate limit exceeded" });
      expect(result.isRateLimit).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('detects "rate-limit" (hyphenated) in stderr', () => {
      const result = detectRateLimit({ stderr: "rate-limit error from API" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "too many requests" in stderr', () => {
      const result = detectRateLimit({ stderr: "Error: Too Many Requests" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects HTTP 429 status code in stderr", () => {
      const result = detectRateLimit({ stderr: "HTTP 429 Too Many Requests" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects error 429 in stderr", () => {
      const result = detectRateLimit({ stderr: "error 429: rate limited" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects status 429 in stderr", () => {
      const result = detectRateLimit({ stderr: "status: 429" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "quota exceeded" in stderr', () => {
      const result = detectRateLimit({ stderr: "API quota exceeded for this project" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "quota-exceeded" (hyphenated) in stderr', () => {
      const result = detectRateLimit({ stderr: "quota-exceeded" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "overloaded" in stderr', () => {
      const result = detectRateLimit({ stderr: "The service is overloaded" });
      expect(result.isRateLimit).toBe(true);
    });

    it("returns false for non-rate-limit errors", () => {
      const result = detectRateLimit({ stderr: "TypeError: undefined is not a function" });
      expect(result.isRateLimit).toBe(false);
      expect(result.message).toBeUndefined();
      expect(result.retryAfter).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Only checks stderr (not stdout)
  // -----------------------------------------------------------------------

  describe("stderr-only principle", () => {
    it("does NOT detect rate limit patterns when stderr is empty", () => {
      const result = detectRateLimit({ stderr: "", exitCode: 0 });
      expect(result.isRateLimit).toBe(false);
    });

    it("detects rate limit in stderr", () => {
      const result = detectRateLimit({ stderr: "Error: rate limit exceeded" });
      expect(result.isRateLimit).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Exit code context
  // -----------------------------------------------------------------------

  describe("exit code context", () => {
    it("exit code 429 + loose match = rate limited", () => {
      const result = detectRateLimit({
        stderr: "request was throttled by the server",
        exitCode: 429,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("exit code 0 + empty stderr = NOT rate limited", () => {
      const result = detectRateLimit({
        stderr: "",
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });

    it("exit code 1 + loose pattern = rate limited", () => {
      const result = detectRateLimit({
        stderr: "capacity limit reached, please backoff",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("exit code 2 + loose pattern = rate limited", () => {
      const result = detectRateLimit({
        stderr: "limit exceeded for current billing period",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("non-rate-limit exit code without patterns = not rate limited", () => {
      const result = detectRateLimit({
        stderr: "segfault in module",
        exitCode: 139,
      });
      expect(result.isRateLimit).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Claude-specific patterns
  // -----------------------------------------------------------------------

  describe("claude-specific patterns", () => {
    it('detects "anthropic rate limit"', () => {
      const result = detectRateLimit({
        stderr: "anthropic rate limit error",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "claude is currently overloaded"', () => {
      const result = detectRateLimit({
        stderr: "claude is currently overloaded, please try again later",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "api error 429"', () => {
      const result = detectRateLimit({
        stderr: "api error 429: too many requests",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "API rate limit exceeded"', () => {
      const result = detectRateLimit({
        stderr: "API rate limit exceeded for your organization",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("agent-specific patterns extend common patterns for that agent", () => {
      // "claude is currently overloaded" matches both the claude-specific pattern
      // and the common "overloaded" pattern — but agent-specific patterns give
      // more precise matching. The key: agent patterns are added on top of common.
      const withAgent = detectRateLimit({
        stderr: "claude is currently overloaded",
        agentId: "claude",
      });
      expect(withAgent.isRateLimit).toBe(true);

      // Without agentId, "claude is currently overloaded" still matches
      // the common "overloaded" pattern
      const withoutAgent = detectRateLimit({
        stderr: "claude is currently overloaded",
      });
      expect(withoutAgent.isRateLimit).toBe(true);

      // But "tokens per minute" is opencode-specific and won't match without agentId
      const opencodeOnly = detectRateLimit({
        stderr: "tokens per minute limit reached",
        agentId: "opencode",
      });
      expect(opencodeOnly.isRateLimit).toBe(true);

      const noAgent = detectRateLimit({
        stderr: "tokens per minute limit reached",
      });
      // Without opencode agentId, "tokens per minute" doesn't match any common pattern
      expect(noAgent.isRateLimit).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // OpenCode-specific patterns
  // -----------------------------------------------------------------------

  describe("opencode-specific patterns", () => {
    it('detects "openai rate limit"', () => {
      const result = detectRateLimit({
        stderr: "openai rate limit: too many requests",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "tokens per minute"', () => {
      const result = detectRateLimit({
        stderr: "Error: tokens per minute limit reached",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "requests per minute"', () => {
      const result = detectRateLimit({
        stderr: "requests per minute exceeded",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "azure throttle"', () => {
      const result = detectRateLimit({
        stderr: "azure openai throttled your request",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Retry-after extraction
  // -----------------------------------------------------------------------

  describe("retry-after extraction", () => {
    it('extracts from "retry-after: 30s"', () => {
      const result = detectRateLimit({
        stderr: "rate limit exceeded\nretry-after: 30s",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(30);
    });

    it('extracts from "retry after: 60s"', () => {
      const result = detectRateLimit({
        stderr: "rate limit\nretry after: 60s",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(60);
    });

    it('extracts seconds from "too many requests" pattern', () => {
      const result = detectRateLimit({
        stderr: "Too many requests. Please wait 45 seconds.",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(45);
    });

    it("extracts retry-after via loose fallback with exit code", () => {
      const result = detectRateLimit({
        stderr: "throttled. retry-after: 20s",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(20);
    });

    it("returns undefined retryAfter when no duration found", () => {
      const result = detectRateLimit({
        stderr: "Error: rate limit exceeded, please slow down",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBeUndefined();
    });

    it("rejects unreasonably large retry-after values (>= 3600s)", () => {
      const result = detectRateLimit({
        stderr: "rate limit exceeded. retry-after: 7200s",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Message context extraction
  // -----------------------------------------------------------------------

  describe("message context extraction", () => {
    it("extracts context around the match (50 chars before, 100 after)", () => {
      const prefix = "A".repeat(60);
      const suffix = "B".repeat(120);
      const stderr = `${prefix}rate limit exceeded${suffix}`;
      const result = detectRateLimit({ stderr });
      expect(result.isRateLimit).toBe(true);
      // Message should include up to 50 chars before and 100 after
      expect(result.message).toBeDefined();
      expect(result.message!.length).toBeLessThanOrEqual(201); // 200 + "..."
      expect(result.message).toContain("rate limit exceeded");
    });

    it("truncates messages longer than 200 characters", () => {
      const long = "X".repeat(100) + "rate limit" + "Y".repeat(200);
      const result = detectRateLimit({ stderr: long });
      expect(result.isRateLimit).toBe(true);
      expect(result.message!.length).toBeLessThanOrEqual(203); // 200 + "..."
    });

    it("collapses whitespace in extracted message", () => {
      const result = detectRateLimit({
        stderr: "Error:   rate limit   exceeded\n\nplease wait",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.message).not.toMatch(/\s{2,}/);
    });
  });

  // -----------------------------------------------------------------------
  // Loose fallback patterns
  // -----------------------------------------------------------------------

  describe("loose fallback patterns", () => {
    it('detects "throttled" with matching exit code', () => {
      const result = detectRateLimit({
        stderr: "your request was throttled",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "limit exceeded" with matching exit code', () => {
      const result = detectRateLimit({
        stderr: "limit exceeded for account",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "exceeded limit" with matching exit code', () => {
      const result = detectRateLimit({
        stderr: "you have exceeded limit for this period",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "capacity" with matching exit code', () => {
      const result = detectRateLimit({
        stderr: "server at capacity, try again later",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "backoff" with matching exit code', () => {
      const result = detectRateLimit({
        stderr: "exponential backoff required",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("loose patterns alone (without matching exit code) do NOT trigger", () => {
      const result = detectRateLimit({
        stderr: "throttled request",
        exitCode: 139, // not in RATE_LIMIT_EXIT_CODES
      });
      expect(result.isRateLimit).toBe(false);
    });

    it("loose patterns with exit code 0 do NOT trigger", () => {
      // exitCode 0 + non-empty stderr doesn't enter the loose check path
      // (loose check only runs when exitCode !== 0)
      const result = detectRateLimit({
        stderr: "throttled",
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });
  });
});

