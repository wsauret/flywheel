import { describe, it, expect, beforeEach } from "bun:test";
import {
  RateLimitDetector,
  RATE_LIMIT_RETRY_OPTIONS,
  type RateLimitDetectionInput,
} from "../src/orchestration/engines/subprocess/rate-limit";

// ---------------------------------------------------------------------------
// RateLimitDetector — class-based detection
// ---------------------------------------------------------------------------

describe("RateLimitDetector", () => {
  let detector: RateLimitDetector;

  beforeEach(() => {
    detector = new RateLimitDetector();
  });

  // -----------------------------------------------------------------------
  // Common patterns (agent-agnostic)
  // -----------------------------------------------------------------------

  describe("common patterns", () => {
    it('detects "rate limit" in stderr', () => {
      const result = detector.detect({ stderr: "Error: rate limit exceeded" });
      expect(result.isRateLimit).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('detects "rate-limit" (hyphenated) in stderr', () => {
      const result = detector.detect({ stderr: "rate-limit error from API" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "too many requests" in stderr', () => {
      const result = detector.detect({ stderr: "Error: Too Many Requests" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects HTTP 429 status code in stderr", () => {
      const result = detector.detect({ stderr: "HTTP 429 Too Many Requests" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects error 429 in stderr", () => {
      const result = detector.detect({ stderr: "error 429: rate limited" });
      expect(result.isRateLimit).toBe(true);
    });

    it("detects status 429 in stderr", () => {
      const result = detector.detect({ stderr: "status: 429" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "quota exceeded" in stderr', () => {
      const result = detector.detect({ stderr: "API quota exceeded for this project" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "quota-exceeded" (hyphenated) in stderr', () => {
      const result = detector.detect({ stderr: "quota-exceeded" });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "overloaded" in stderr', () => {
      const result = detector.detect({ stderr: "The service is overloaded" });
      expect(result.isRateLimit).toBe(true);
    });

    it("returns false for non-rate-limit errors", () => {
      const result = detector.detect({ stderr: "TypeError: undefined is not a function" });
      expect(result.isRateLimit).toBe(false);
      expect(result.message).toBeUndefined();
      expect(result.retryAfter).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Only checks stderr (not stdout)
  // -----------------------------------------------------------------------

  describe("stderr-only principle", () => {
    it("does NOT detect rate limit patterns in stdout (avoids false positives)", () => {
      const result = detector.detect({
        stderr: "",
        stdout: 'console.log("rate limit reached")',
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });

    it("detects rate limit in stderr even when stdout is clean", () => {
      const result = detector.detect({
        stderr: "Error: rate limit exceeded",
        stdout: "normal output",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("ignores stdout containing 429 code references", () => {
      const result = detector.detect({
        stderr: "",
        stdout: "// Handle HTTP 429 errors\nif (status === 429) { retry(); }",
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Exit code context
  // -----------------------------------------------------------------------

  describe("exit code context", () => {
    it("exit code 429 + loose match = rate limited", () => {
      const result = detector.detect({
        stderr: "request was throttled by the server",
        exitCode: 429,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("exit code 0 + empty stderr = NOT rate limited", () => {
      const result = detector.detect({
        stderr: "",
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });

    it("exit code 1 + loose pattern = rate limited", () => {
      const result = detector.detect({
        stderr: "capacity limit reached, please backoff",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("exit code 2 + loose pattern = rate limited", () => {
      const result = detector.detect({
        stderr: "limit exceeded for current billing period",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("non-rate-limit exit code without patterns = not rate limited", () => {
      const result = detector.detect({
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
      const result = detector.detect({
        stderr: "anthropic rate limit error",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "claude is currently overloaded"', () => {
      const result = detector.detect({
        stderr: "claude is currently overloaded, please try again later",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "api error 429"', () => {
      const result = detector.detect({
        stderr: "api error 429: too many requests",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "API rate limit exceeded"', () => {
      const result = detector.detect({
        stderr: "API rate limit exceeded for your organization",
        agentId: "claude",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("agent-specific patterns extend common patterns for that agent", () => {
      // "claude is currently overloaded" matches both the claude-specific pattern
      // and the common "overloaded" pattern — but agent-specific patterns give
      // more precise matching. The key: agent patterns are added on top of common.
      const withAgent = detector.detect({
        stderr: "claude is currently overloaded",
        agentId: "claude",
      });
      expect(withAgent.isRateLimit).toBe(true);

      // Without agentId, "claude is currently overloaded" still matches
      // the common "overloaded" pattern
      const withoutAgent = detector.detect({
        stderr: "claude is currently overloaded",
      });
      expect(withoutAgent.isRateLimit).toBe(true);

      // But "tokens per minute" is opencode-specific and won't match without agentId
      const opencodeOnly = detector.detect({
        stderr: "tokens per minute limit reached",
        agentId: "opencode",
      });
      expect(opencodeOnly.isRateLimit).toBe(true);

      const noAgent = detector.detect({
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
      const result = detector.detect({
        stderr: "openai rate limit: too many requests",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "tokens per minute"', () => {
      const result = detector.detect({
        stderr: "Error: tokens per minute limit reached",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "requests per minute"', () => {
      const result = detector.detect({
        stderr: "requests per minute exceeded",
        agentId: "opencode",
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "azure throttle"', () => {
      const result = detector.detect({
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
      const result = detector.detect({
        stderr: "rate limit exceeded\nretry-after: 30s",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(30);
    });

    it('extracts from "retry after: 60s"', () => {
      const result = detector.detect({
        stderr: "rate limit\nretry after: 60s",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(60);
    });

    it('extracts seconds from "too many requests" pattern', () => {
      const result = detector.detect({
        stderr: "Too many requests. Please wait 45 seconds.",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(45);
    });

    it("extracts retry-after via loose fallback with exit code", () => {
      const result = detector.detect({
        stderr: "throttled. retry-after: 20s",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBe(20);
    });

    it("returns undefined retryAfter when no duration found", () => {
      const result = detector.detect({
        stderr: "Error: rate limit exceeded, please slow down",
      });
      expect(result.isRateLimit).toBe(true);
      expect(result.retryAfter).toBeUndefined();
    });

    it("rejects unreasonably large retry-after values (>= 3600s)", () => {
      const result = detector.detect({
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
      const result = detector.detect({ stderr });
      expect(result.isRateLimit).toBe(true);
      // Message should include up to 50 chars before and 100 after
      expect(result.message).toBeDefined();
      expect(result.message!.length).toBeLessThanOrEqual(201); // 200 + "..."
      expect(result.message).toContain("rate limit exceeded");
    });

    it("truncates messages longer than 200 characters", () => {
      const long = "X".repeat(100) + "rate limit" + "Y".repeat(200);
      const result = detector.detect({ stderr: long });
      expect(result.isRateLimit).toBe(true);
      expect(result.message!.length).toBeLessThanOrEqual(203); // 200 + "..."
    });

    it("collapses whitespace in extracted message", () => {
      const result = detector.detect({
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
      const result = detector.detect({
        stderr: "your request was throttled",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "limit exceeded" with matching exit code', () => {
      const result = detector.detect({
        stderr: "limit exceeded for account",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "exceeded limit" with matching exit code', () => {
      const result = detector.detect({
        stderr: "you have exceeded limit for this period",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "capacity" with matching exit code', () => {
      const result = detector.detect({
        stderr: "server at capacity, try again later",
        exitCode: 1,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it('detects "backoff" with matching exit code', () => {
      const result = detector.detect({
        stderr: "exponential backoff required",
        exitCode: 2,
      });
      expect(result.isRateLimit).toBe(true);
    });

    it("loose patterns alone (without matching exit code) do NOT trigger", () => {
      const result = detector.detect({
        stderr: "throttled request",
        exitCode: 139, // not in RATE_LIMIT_EXIT_CODES
      });
      expect(result.isRateLimit).toBe(false);
    });

    it("loose patterns with exit code 0 do NOT trigger", () => {
      // exitCode 0 + non-empty stderr doesn't enter the loose check path
      // (loose check only runs when exitCode !== 0)
      const result = detector.detect({
        stderr: "throttled",
        exitCode: 0,
      });
      expect(result.isRateLimit).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration with retry<T>()
// ---------------------------------------------------------------------------

describe("RATE_LIMIT_RETRY_OPTIONS", () => {
  it("uses baseDelayMs: 5000", () => {
    expect(RATE_LIMIT_RETRY_OPTIONS.baseDelayMs).toBe(5_000);
  });

  it("uses exponential backoff", () => {
    expect(RATE_LIMIT_RETRY_OPTIONS.backoff).toBe("exponential");
  });

  it("uses maxDelayMs: 120000 (2 min cap)", () => {
    expect(RATE_LIMIT_RETRY_OPTIONS.maxDelayMs).toBe(120_000);
  });

  it("uses multiplier: 2", () => {
    expect(RATE_LIMIT_RETRY_OPTIONS.multiplier).toBe(2);
  });
});
