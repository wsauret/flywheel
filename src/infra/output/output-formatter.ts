import { sanitizeExternalText } from "../control-characters.js";
import { boundProviderDetail, classifyApiError } from "../llm/provider-error-copy.js";
import type { LlmToolOutputPart } from "../llm/tool-output-part-schema.js";
import type { AgentFailureDisplay } from "../output-blocks.js";

// Sanitized here so every error display path (agent, row, standalone) gets
// clean text: failing commands are exactly when colored stderr shows up.
export function extractErrorText(content: LlmToolOutputPart[] | undefined): string | undefined {
  if (!content) return undefined;
  for (const part of content) {
    if (part.type === "text") return sanitizeExternalText(part.text);
  }
  return undefined;
}

/** Row summary for a blocked (wait-state) tool result: the message's first
 *  line, untruncated. The full text renders separately as a system notice. */
export function blockedStatusLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

const RE_INPUT_VALIDATION = /^<tool_use_error>InputValidationError:\s*(.+?)<\/tool_use_error>$/s;
const RE_RUNTIME_INPUT_VALIDATION = /^[^\n]+ failed due to the following issues?:\n([\s\S]*?)\nThe tool was not executed\./i;
const RE_TOOL_USE_ERROR = /^<tool_use_error>(.+?)<\/tool_use_error>$/s;
const RE_NO_SUCH_TOOL = /^Error: No such tool available:\s*(.+)$/;
// Real dispatch + bash-guard messages whose actionable point is buried after a generic
// preamble, so first-sentence distillation would truncate away the part that matters.
const RE_UNKNOWN_TOOL = /^Unknown tool '([^']+)'/;
const RE_BASH_INTERCEPT = /Use the `(\w+)` tool instead/;
const RE_SENSITIVE_EDIT = /^Claude requested permissions to edit (.+?) which is a sensitive file/;
const RE_SENSITIVE_WRITE = /^Claude requested permissions to write to (.+?) which is a sensitive file/;
const RE_SENSITIVE_READ = /^Claude requested permissions to read from (.+?) which is a sensitive file/;
const RE_MEMORY_CAPACITY = /^(?:Memory at |Replacement would put memory at |After applying all \d+ operations, memory would be at )[\s\S]*?(?:exceed the limit by|over the limit by) ([\d,]+) chars/;

const DETAIL_MAX_LEN = 60;

// Distil arbitrary error text to a single user-facing headline. Errors lead with the
// salient fact and trail agent-directed remediation ("The runner exited…", "retry with a
// tighter scope", "Pick one of the registered agents…"), so the first sentence of the first
// non-empty line is the part worth showing. Redundant failure leads are dropped because the
// surrounding block already signals failure with its red text + label: the terse "<subject>
// failed:/error:/rejected:" forms, the natural-language "Failed to read '<path>':" form, and
// stacked leads ("Edit failed: Edit rejected: …") are peeled off iteratively. The leading errno
// code ("ENOENT: "), the trailing fs syscall clause (", open '<path>'"), and a trailing
// parenthetical ("(marked *)") are dropped too, leaving just the readable cause.
const LEAD_RE = /^.{0,48}?\b(?:failed|errored|error|rejected|denied)\b(?:\s*[:—]|[^:—]*?'[^']*'[^:—]*[:—])\s*/i;
function headline(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const boundary = line.search(/[.!?](?:\s|$)/);
  let sentence = (boundary >= 0 ? line.slice(0, boundary) : line).trim();
  for (let prev = ""; sentence !== prev; ) {
    prev = sentence;
    sentence = sentence.replace(LEAD_RE, "");
  }
  sentence = sentence
    .replace(/,\s*[a-z]+\s+'[^']*'\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^E[A-Z]+:\s*/, "")
    .trim();
  if (sentence.length <= DETAIL_MAX_LEN) return sentence;
  return `${sentence.slice(0, DETAIL_MAX_LEN - 1)}…`;
}

function capitalize(text: string): string {
  // charAt returns "" past the end, so no bounds assertion is needed.
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Produce the red cause text shown after a tool row's "<verb> <detail>" heading. The row
// already names the actor and the red color signals failure, so no "<tool> failed:" prefix is
// added — that would just restate the verb. Self-contained messages (unavailable tool, rejected
// sensitive path) keep their own framing; everything else is distilled to the bare cause.
export function launderToolError(text: string): string {
  let rawError = text;
  if (rawError.trimStart().startsWith("{")) {
    try {
      const envelope: unknown = JSON.parse(rawError);
      if (typeof envelope !== "object" || envelope === null || !("error" in envelope) || typeof envelope.error !== "string" || !envelope.error.trim()) {
        return "Tool failed";
      }
      rawError = sanitizeExternalText(envelope.error);
    } catch {
      // External tool text can contain an incomplete JSON envelope.
      return "Tool failed";
    }
  }
  const capacity = rawError.match(RE_MEMORY_CAPACITY);
  if (capacity) return `Memory update exceeds the limit by ${capacity[1]} characters`;

  let match = rawError.match(RE_INPUT_VALIDATION);
  if (match?.[1] !== undefined) return `Invalid input: ${headline(match[1])}`;

  match = rawError.match(RE_NO_SUCH_TOOL);
  if (match) return `Tool not available: ${match[1]}`;

  match = rawError.match(RE_UNKNOWN_TOOL);
  if (match) return `Unknown tool '${match[1]}'`;

  match = rawError.match(RE_BASH_INTERCEPT);
  if (match) return `Use the ${match[1]} tool instead`;

  match = rawError.match(RE_SENSITIVE_EDIT);
  if (match) return `Edit rejected: ${match[1]} is a protected file`;

  match = rawError.match(RE_SENSITIVE_WRITE);
  if (match) return `Write rejected: ${match[1]} is a protected file`;

  match = rawError.match(RE_SENSITIVE_READ);
  if (match) return `Read rejected: ${match[1]} is a protected file`;

  match = rawError.match(RE_TOOL_USE_ERROR);
  if (match?.[1] !== undefined) return capitalize(headline(match[1])) || "Failed";

  return capitalize(headline(rawError)) || "Failed";
}

const SUBAGENT_PROVIDER_FAILURE = /^Subagent '[^']+'(?: \([^)]*\))? failed:\s*([\s\S]+)$/;
const RUNNER_GUIDANCE = /\s+The runner exited before producing a result;[\s\S]*$/;
const TOKEN_BUDGET = /requested up to\s+(\d+)\s+tokens, but can only afford\s+(\d+)/i;
const CREDIT_URL = /https:\/\/[^\s]+\/settings\/credits/i;
const FORMATTED_API_FAILURE = /^(?:Authentication failed|Account confirmation required|Out of credits|Rate limited|Model not available|Model context limit|Provider rejected the request|Model request failed)\b/i;

/** User-facing failure content for a subagent transcript row. Provider failures
 * reuse the canonical provider classifier; generic dispatch failures keep their
 * concrete cause and receive one safe next step. */
export function formatAgentFailureDisplay(rawError: string): AgentFailureDisplay {
  const providerMatch = rawError.match(SUBAGENT_PROVIDER_FAILURE);
  const cause = providerMatch?.[1]?.replace(RUNNER_GUIDANCE, "").trim() ?? rawError;
  if (providerMatch && FORMATTED_API_FAILURE.test(cause)) {
    const copy = classifyApiError(cause);
    const tokenBudget = cause.match(TOKEN_BUDGET);
    if (copy.presentation === "provider.out_of_credits" && tokenBudget?.[1] !== undefined && tokenBudget[2] !== undefined) {
      const requested = Number(tokenBudget[1]).toLocaleString("en-US");
      const affordable = Number(tokenBudget[2]).toLocaleString("en-US");
      const provider = /openrouter/i.test(cause) ? "OpenRouter" : "The provider";
      const creditUrl = cause.match(CREDIT_URL)?.[0]?.replace(/[.,;]+$/, "");
      return {
        title: copy.title,
        message: `${provider} could not fund the requested ${requested}-token output limit.`,
        guidance: `Run /model to assign this subagent role to another model, or add ${provider === "OpenRouter" ? "OpenRouter" : "provider"} credits, then retry.`,
        detail: `The account can currently fund up to ${affordable} tokens.${creditUrl ? ` Add credits: ${creditUrl}` : ""}`,
        ...(copy.action ? { action: copy.action } : {}),
      };
    }
    return {
      title: copy.title,
      message: copy.message,
      guidance: copy.guidance ?? "Send a message to retry.",
      ...(copy.detail ? { detail: boundProviderDetail(copy.detail) } : {}),
      ...(copy.action ? { action: copy.action } : {}),
    };
  }

  const inputValidation = cause.match(RE_INPUT_VALIDATION)?.[1] ?? cause.match(RE_RUNTIME_INPUT_VALIDATION)?.[1];
  if (inputValidation !== undefined) {
    return {
      title: "Subagent failed",
      message: `Invalid input: ${inputValidation.split("\n").join("; ")}`,
      guidance: "Correct the tool input and retry.",
    };
  }

  return {
    title: "Subagent failed",
    message: launderToolError(cause),
    guidance: "Send a message to retry.",
  };
}

/** Prefer complete producer-authored presentation, but never let incomplete
 * presentation metadata hide the canonical raw failure evidence. */
export function resolveAgentFailureDisplay(
  rawError: string,
  structured: AgentFailureDisplay | undefined,
): AgentFailureDisplay {
  if (
    structured
    && structured.title.trim().length > 0
    && structured.message.trim().length > 0
    && structured.guidance.trim().length > 0
  ) {
    return structured;
  }
  return formatAgentFailureDisplay(rawError);
}

