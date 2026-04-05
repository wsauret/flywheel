/**
 * Context management: output truncation, token estimation, usage formatting.
 */

import type { UsageInfo } from "./llm.js";
import { TRUNCATION_MARKER } from "../worker/buffer.js";

const DEFAULT_MAX_BYTES = 50 * 1024; // 50 KB
const CHARS_PER_TOKEN = 4;

/**
 * Truncates output that exceeds maxBytes, keeping the first and last halves
 * with a truncation marker in between.
 */
export function limitOutput(output: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const encoded = new TextEncoder().encode(output);
  if (encoded.byteLength <= maxBytes) return output;

  const portion = Math.floor(maxBytes / 2);
  const firstBytes = encoded.slice(0, portion);
  const lastBytes = encoded.slice(-portion);
  const first = new TextDecoder("utf-8", { fatal: false }).decode(firstBytes);
  const last = new TextDecoder("utf-8", { fatal: false }).decode(lastBytes);
  const omitted = encoded.byteLength - firstBytes.byteLength - lastBytes.byteLength;

  return `${first}\n${TRUNCATION_MARKER}[...truncated ${omitted} bytes...]\n${last}`;
}

/**
 * Character-based token estimate (4 chars ~ 1 token).
 * Suitable only for pre-request budget checks, not billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Formats usage info into a human-readable summary. */
export function formatUsageStats(usage: UsageInfo): string {
  const parts: string[] = [
    `input: ${usage.inputTokens}`,
    `output: ${usage.outputTokens}`,
  ];
  if (usage.cacheReadInputTokens) {
    parts.push(`cache_read: ${usage.cacheReadInputTokens}`);
  }
  if (usage.cacheCreationInputTokens) {
    parts.push(`cache_create: ${usage.cacheCreationInputTokens}`);
  }
  return `tokens(${parts.join(", ")})`;
}
