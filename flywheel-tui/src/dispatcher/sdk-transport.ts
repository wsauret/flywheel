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
let _createOpencodeClient: (() => unknown) | null = null;

try {
  const sdk = await import("@opencode-ai/sdk");
  if (sdk.createOpencodeClient) {
    _createOpencodeClient = sdk.createOpencodeClient as () => unknown;
    _sdkAvailable = true;
  }
} catch {
  // SDK not available — that's fine
}

export const SDK_AVAILABLE: boolean = _sdkAvailable;

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

const SDK_TIMEOUT_MS = 30_000;

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
        parts: Array<{ type: "text"; text: string }>;
      };
    }) => Promise<{ data?: unknown; error?: unknown }>;
  };
}

// ---------------------------------------------------------------------------
// SdkTransport
// ---------------------------------------------------------------------------

export class SdkTransport implements DispatcherTransport {
  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    if (!SDK_AVAILABLE || !_createOpencodeClient) {
      throw new Error("@opencode-ai/sdk is not available");
    }

    const client = _createOpencodeClient() as SdkClient;

    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}${JSON.stringify(input)}`;

    log.debug("prompt segments", {
      systemLen: systemPrompt.length,
      userLen: userContent.length,
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
    const promptPromise = client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
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

    return parseDecision(responseText);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromResponse(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    // Try common response shapes
    const obj = data as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.output === "string") return obj.output;
    // Try stringifying the whole thing
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
    throw new Error(`Invalid dispatcher decision: ${result.error.message}`);
  }

  return result.data;
}
