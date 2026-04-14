export type RateLimitDetectionResult =
  | { isRateLimit: false }
  | { isRateLimit: true; message: string; retryAfter?: number };

export interface RateLimitDetectionInput {
  stderr: string;
  exitCode?: number;
}

interface RateLimitPattern {
  pattern: RegExp;
  retryAfterPattern?: RegExp;
}

const COMMON_PATTERNS: RateLimitPattern[] = [
  // HTTP 429 status code - must appear in error/HTTP context, not just any "429"
  // Matches: "429 Too Many", "HTTP 429", "status 429", "error 429", "code 429"
  // Excludes: line numbers like "429→" or "line 429"
  {
    pattern: /(?:HTTP|status|error|code|response)[\s:]*429|429\s*(?:too many|rate limit|error)/i,
    retryAfterPattern: /retry[- ]?after[:\s]+(\d+)\s*s/i,
  },
  // Generic rate limit phrases
  // NOTE: Requires space or hyphen separator to avoid matching package names like @upstash/ratelimit
  {
    pattern: /rate[- ]limit/i,
    retryAfterPattern: /retry[- ]?after[:\s]+(\d+)\s*s/i,
  },
  // Too many requests
  {
    pattern: /too many requests/i,
    retryAfterPattern: /(\d+)\s*seconds?/i,
  },
  // Quota exceeded
  {
    pattern: /quota[- ]?exceeded/i,
    retryAfterPattern: /(\d+)\s*seconds?/i,
  },
  // Overloaded
  {
    pattern: /\boverloaded\b/i,
    retryAfterPattern: /(\d+)\s*seconds?/i,
  },
];

const RATE_LIMIT_EXIT_CODES = new Set([1, 2, 429]);

// Only checks stderr to avoid false positives from code in stdout.

export function detectRateLimit(input: RateLimitDetectionInput): RateLimitDetectionResult {
  const { stderr, exitCode } = input;

  if (!stderr.trim() && exitCode === 0) {
    return { isRateLimit: false };
  }

  const patterns = COMMON_PATTERNS;

  for (const { pattern, retryAfterPattern } of patterns) {
    if (pattern.test(stderr)) {
      return {
        isRateLimit: true,
        message: extractMessage(stderr, pattern),
        retryAfter: retryAfterPattern ? extractRetryAfter(stderr, retryAfterPattern) : undefined,
      };
    }
  }

  // Non-zero exit + loose keyword match as secondary indicator
  if (exitCode !== undefined && exitCode !== 0) {
    const looseMatch = looseRateLimitCheck(stderr);
    if (looseMatch && RATE_LIMIT_EXIT_CODES.has(exitCode)) {
      return { isRateLimit: true, message: looseMatch, retryAfter: extractAnyRetryAfter(stderr) };
    }
  }

  return { isRateLimit: false };
}

function extractMessage(output: string, pattern: RegExp): string {
  const match = output.match(pattern);
  if (!match) return "Rate limit detected";

  const matchIndex = match.index ?? 0;
  const start = Math.max(0, matchIndex - 50);
  const end = Math.min(output.length, matchIndex + match[0].length + 100);
  let message = output.slice(start, end).trim().replace(/\s+/g, " ");
  if (message.length > 200) message = message.slice(0, 200) + "...";
  return message;
}

function extractRetryAfter(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (match?.[1]) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds) && seconds > 0 && seconds < 3600) return seconds;
  }
  return undefined;
}

function extractAnyRetryAfter(output: string): number | undefined {
  const patterns = [
    /retry[- ]?after[:\s]+(\d+)\s*s/i,
    /wait[:\s]+(\d+)\s*s/i,
    /try again in[:\s]+(\d+)\s*s/i,
    /(\d+)\s*seconds?(?:\s*(?:before|until|wait))/i,
  ];
  for (const p of patterns) {
    const match = output.match(p);
    if (match?.[1]) {
      const seconds = parseInt(match[1], 10);
      if (!isNaN(seconds) && seconds > 0 && seconds < 3600) return seconds;
    }
  }
  return undefined;
}

function looseRateLimitCheck(output: string): string | null {
  const loosePatterns = [/throttl/i, /limit.*exceeded/i, /exceeded.*limit/i, /capacity/i, /backoff/i];
  for (const p of loosePatterns) {
    if (p.test(output)) return extractMessage(output, p);
  }
  return null;
}

