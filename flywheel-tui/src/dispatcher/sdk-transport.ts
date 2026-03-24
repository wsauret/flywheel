/**
 * SdkTransport — uses @opencode-ai/sdk to invoke the dispatcher.
 *
 * If the SDK is available, creates a session and sends the prompt.
 * If the SDK is not available (import fails), SDK_AVAILABLE is false
 * and SdkTransport.invoke() will always throw.
 *
 * The system prompt is passed via the `system` body field so the hosting
 * runtime (OpenCode) can cache the stable prefix across invocations.
 * Variable per-call content (truncation notes + input JSON) goes in
 * `parts` as user content.
 */

import type { DispatcherInput, DispatcherDecision } from "../schemas/dispatcher";
import type { DispatcherTransport } from "./transport";
import { DispatcherDecisionSchema } from "../schemas/dispatcher";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// SDK availability detection
// ---------------------------------------------------------------------------

let _sdkAvailable = false;
let _createOpencodeClient: ((config?: { baseUrl?: string }) => unknown) | null = null;
let _createOpencodeServer: ((opts?: Record<string, unknown>) => Promise<{ url: string; close(): void }>) | null = null;

try {
  const sdk = await import("@opencode-ai/sdk");
  if (sdk.createOpencodeClient) {
    _createOpencodeClient = sdk.createOpencodeClient as (config?: { baseUrl?: string }) => unknown;
    _sdkAvailable = true;
  }
  if (sdk.createOpencodeServer) {
    _createOpencodeServer = sdk.createOpencodeServer as (opts?: Record<string, unknown>) => Promise<{ url: string; close(): void }>;
  }
} catch {
  // SDK not available — that's fine
}

export const SDK_AVAILABLE: boolean = _sdkAvailable;
export { _createOpencodeServer };

// ---------------------------------------------------------------------------
// Testing seam — allows tests to inject a mock client factory.
// ---------------------------------------------------------------------------

/** @internal — for tests only. Replaces the client factory used by SdkTransport. */
export function _setClientFactoryForTesting(factory: (() => unknown) | null): void {
  _createOpencodeClient = factory;
  _sdkAvailable = factory !== null;
}

// ---------------------------------------------------------------------------
// Timeout constant
// ---------------------------------------------------------------------------

const SDK_TIMEOUT_MS = 120_000;

const log = Log.create({ service: "sdk-transport" });

// ---------------------------------------------------------------------------
// SDK client type — mirrors the subset of the @opencode-ai/sdk client API
// that we use: session.create() and session.prompt().
// ---------------------------------------------------------------------------

/** @internal — exported for testing. */
export interface SdkClient {
  session: {
    create: (opts: object) => Promise<{ data?: { id: string }; error?: unknown }>;
    prompt: (opts: {
      path: { id: string };
      body: {
        system?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
        parts: Array<{ type: "text"; text: string }>;
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

// ---------------------------------------------------------------------------
// Default model for OpenCode engine
// ---------------------------------------------------------------------------

const DEFAULT_OPENCODE_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Parse a model string like "anthropic/claude-sonnet-4-6" into { providerID, modelID }.
 * If no "/" is present, defaults providerID to "anthropic".
 */
function parseModelString(model: string): { providerID: string; modelID: string } {
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    return {
      providerID: model.slice(0, slashIdx),
      modelID: model.slice(slashIdx + 1),
    };
  }
  return { providerID: "anthropic", modelID: model };
}

// ---------------------------------------------------------------------------
// SdkTransport
// ---------------------------------------------------------------------------

export interface SdkTransportOptions {
  baseUrl?: string;
  /** Engine name — must be "opencode" (or omitted). SDK is OpenCode-only. */
  engineName?: string;
  /** Dispatcher model override — e.g. "anthropic/claude-sonnet-4-6". Uses default when not set. */
  dispatcherModel?: string;
}

export class SdkTransport implements DispatcherTransport {
  private readonly baseUrl: string;
  private readonly modelSpec: { providerID: string; modelID: string };

  constructor(options?: SdkTransportOptions) {
    // Guard: SDK transport is exclusively for OpenCode
    const engineName = options?.engineName ?? "opencode";
    if (engineName !== "opencode") {
      throw new Error(
        `SDK transport is OpenCode-only — cannot be used with engine "${engineName}". ` +
        `Use SubprocessTransport for non-opencode engines.`,
      );
    }

    this.baseUrl = options?.baseUrl ?? "";

    // Resolve model: parse dispatcher model or use default
    const modelStr = options?.dispatcherModel ?? DEFAULT_OPENCODE_MODEL;
    this.modelSpec = parseModelString(modelStr);

    log.debug("SDK transport initialized", {
      engine: engineName,
      providerID: this.modelSpec.providerID,
      modelID: this.modelSpec.modelID,
    });
  }

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    if (!SDK_AVAILABLE || !_createOpencodeClient) {
      throw new Error("@opencode-ai/sdk is not available");
    }

    const client = _createOpencodeClient({ baseUrl: this.baseUrl }) as SdkClient;

    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}${JSON.stringify(input)}`;

    log.debug("prompt segments", {
      systemLen: systemPrompt.length,
      userLen: userContent.length,
      model: `${this.modelSpec.providerID}/${this.modelSpec.modelID}`,
    });

    // Create a session
    const sessionResult = await client.session.create({});
    if (sessionResult.error || !sessionResult.data?.id) {
      throw new Error(`Failed to create SDK session: ${JSON.stringify(sessionResult.error)}`);
    }

    const sessionId = sessionResult.data.id;

    // Send prompt with system/user separation for prompt caching.
    // The stable system prompt goes in `system` (cacheable prefix).
    // Variable per-call content goes in `parts` as user text.
    // Model is passed per the SDK's SessionPromptData.body.model spec.
    const promptPromise = client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
        model: this.modelSpec,
        parts: [{ type: "text" as const, text: userContent }],
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("SDK dispatcher timeout (30s)")), SDK_TIMEOUT_MS),
    );

    const result = await Promise.race([promptPromise, timeoutPromise]);

    if ((result as { error?: unknown }).error) {
      throw new Error(`SDK prompt failed: ${JSON.stringify((result as { error: unknown }).error)}`);
    }

    // Extract text response and parse as JSON
    const responseData = (result as { data?: unknown }).data;
    const responseText = extractTextFromResponse(responseData);

    log.debug("dispatcher raw response", {
      responseTextLength: responseText.length,
      responseSnippet: responseText.slice(0, 200),
    });

    return parseDecision(responseText);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromResponse(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // OpenCode SDK response shape: { info: {...}, parts: [{ type: "text", text: "..." }] }
    if (Array.isArray(obj.parts)) {
      const textParts = (obj.parts as Array<{ type?: string; text?: string }>)
        .filter(p => p.type === "text" && typeof p.text === "string")
        .map(p => p.text!);
      if (textParts.length > 0) {
        return textParts.join("");
      }
    }

    // Fallback: try common response shapes
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.output === "string") return obj.output;
    // Last resort: stringify
    return JSON.stringify(data);
  }
  return String(data);
}

function parseDecision(text: string): DispatcherDecision {
  // Try to extract JSON from the response (in case of surrounding text)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in dispatcher response: ${text.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`Invalid JSON in dispatcher response: ${jsonMatch[0].slice(0, 200)}`);
  }

  const result = DispatcherDecisionSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    log.warn("dispatcher decision validation failed", {
      issues,
      keys: Object.keys(parsed as Record<string, unknown>),
      rawSnippet: JSON.stringify(parsed).slice(0, 300),
    });
    throw new Error(`Invalid dispatcher decision: ${issues}`);
  }

  return result.data;
}
