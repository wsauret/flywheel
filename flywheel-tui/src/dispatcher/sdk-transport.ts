/**
 * SdkTransport — uses @opencode-ai/sdk to invoke the dispatcher.
 *
 * If the SDK is available, creates a session and sends the prompt.
 * If the SDK is not available (import fails), SDK_AVAILABLE is false
 * and SdkTransport.invoke() will always throw.
 *
 * The system prompt is passed via the `system` body field so the hosting
 * runtime (OpenCode) can cache the stable prefix across invocations.
 * Variable per-call content (truncation notes + input JSON + handoff
 * instruction) goes in `parts` as user text.
 *
 * Decision is read from a handoff file (same mechanism as SubprocessTransport).
 * The dispatcher LLM writes a JSON decision to a file path included in the prompt.
 */

import * as nodePath from "node:path";
import * as fs from "node:fs";
import type { DispatcherInput, DispatcherDecision } from "./schemas";
import type { DispatcherTransport } from "./transport";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt";
import { renderDispatcherHandoffInstruction } from "../handoff/field-specs";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../handoff/reader";
import { DispatcherDecisionHandoffSchema } from "../handoff/schemas";
import { mapHandoffToDecision } from "./map-handoff";
import { Log } from "../utils/log";
import { buildDispatcherHandoffPath, ensureSessionDir } from "../config/paths";

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
// Constants
// ---------------------------------------------------------------------------

const SDK_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 1;

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
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId?: string;
  /** Project base directory for path resolution. */
  baseDir?: string;
}

export class SdkTransport implements DispatcherTransport {
  private readonly baseUrl: string;
  private readonly modelSpec: { providerID: string; modelID: string };
  private readonly sessionId?: string;
  private readonly baseDir: string;

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
    this.sessionId = options?.sessionId;
    this.baseDir = options?.baseDir ?? process.cwd();

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

    const invocationId = crypto.randomUUID();
    if (!this.sessionId) {
      throw new Error("SdkTransport requires sessionId for handoff path construction");
    }
    ensureSessionDir(this.sessionId, this.baseDir);
    const handoffPath = buildDispatcherHandoffPath(this.sessionId, invocationId, this.baseDir);

    const client = _createOpencodeClient({ baseUrl: this.baseUrl }) as SdkClient;

    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    // Append handoff instruction so the dispatcher writes its decision to a file
    const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
    const fullPrompt = `${userContent}\n\n${handoffInstruction}`;

    log.debug("prompt segments", {
      systemLen: systemPrompt.length,
      userLen: fullPrompt.length,
      model: `${this.modelSpec.providerID}/${this.modelSpec.modelID}`,
      handoffPath,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
        : "";

      const promptText = fullPrompt + retryNote;

      // Create a session
      const sessionResult = await client.session.create({});
      if (sessionResult.error || !sessionResult.data?.id) {
        throw new Error(`Failed to create SDK session: ${JSON.stringify(sessionResult.error)}`);
      }

      const sessionId = sessionResult.data.id;

      log.info("sending SDK dispatcher prompt", {
        attempt: attempt + 1,
        model: `${this.modelSpec.providerID}/${this.modelSpec.modelID}`,
        handoffPath,
      });

      // Send prompt with system/user separation for prompt caching.
      // The stable system prompt goes in `system` (cacheable prefix).
      // Variable per-call content (including handoff instruction) goes in `parts` as user text.
      // Model is passed per the SDK's SessionPromptData.body.model spec.
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: {
          system: systemPrompt,
          model: this.modelSpec,
          parts: [{ type: "text" as const, text: promptText }],
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SDK dispatcher timeout (120s)")), SDK_TIMEOUT_MS),
      );

      const result = await Promise.race([promptPromise, timeoutPromise]);

      if ((result as { error?: unknown }).error) {
        throw new Error(`SDK prompt failed: ${JSON.stringify((result as { error: unknown }).error)}`);
      }

      // Read decision from handoff file (not from SDK response text)
      try {
        const handoff = await readHandoff(
          handoffPath,
          DispatcherDecisionHandoffSchema,
        );
        return mapHandoffToDecision(handoff);
      } catch (err) {
        if (err instanceof HandoffMissingError || err instanceof HandoffInvalidError) {
          lastError = err;
          log.warn("SDK dispatcher handoff read failed, retrying", {
            attempt: attempt + 1,
            error: err.message,
          });
          continue;
        }
        // Unexpected error — propagate
        throw err;
      }
    }

    throw new Error(
      `SDK dispatcher failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }
}
