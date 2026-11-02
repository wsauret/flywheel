// ChatGPT backend error parser.
// It surfaces user-friendly messages for usage-limit, rate-limit, and
// plan-restriction failures rather than raw JSON-payload error strings.
// Adapted from pi `codex-sse.ts:141-166` (now `parseErrorResponse` in
// `packages/ai/src/api/openai-codex-responses.ts`), MIT; credited in
// THIRD-PARTY-NOTICES.md.

import { QUOTA_CODES } from "./errors.js";

export interface ChatGptAdapterError {
  message: string;
  friendlyMessage?: string;
  /** Provider code preserved for retry and cross-provider failover policy. */
  code?: string;
  /** Unix seconds at which the hit usage window resets, when the payload names one. */
  resetsAtSeconds?: number;
  /** The payload names a terminal quota code rather than a transient throttle. */
  quotaExhausted: boolean;
}

interface ErrorPayload {
  [key: string]: unknown;
}

export async function parseChatGptAdapterErrorResponse(response: Response): Promise<ChatGptAdapterError> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage: string | undefined;
  let code: string | undefined;
  let resetsAtSeconds: number | undefined;
  let quotaExhausted = false;

  try {
    const err = errorPayload(JSON.parse(raw));
    if (err) {
      code = strOf(err.code) || strOf(err.type) || undefined;
      quotaExhausted = code !== undefined && QUOTA_CODES.has(code);
      if (quotaExhausted || /rate_limit_exceeded/i.test(code ?? "") || response.status === 429) {
        const planType = strOf(err.plan_type);
        const plan = planType ? ` (${planType.toLowerCase()} plan)` : "";
        resetsAtSeconds = numOf(err.resets_at);
        const mins = resetsAtSeconds !== undefined
          ? Math.max(0, Math.round((resetsAtSeconds * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = strOf(err.message) || friendlyMessage || message;
    }
  } catch {
    // Keep the generic message when the provider payload is malformed.
  }

  return { message, friendlyMessage, ...(code ? { code } : {}), resetsAtSeconds, quotaExhausted };
}

function errorPayload(parsed: unknown): ErrorPayload | undefined {
  if (!isRecord(parsed)) return undefined;
  const error = parsed.error;
  return isRecord(error) ? error : undefined;
}

function isRecord<Value>(value: Value): value is Value & ErrorPayload {
  return typeof value === "object" && value !== null;
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
