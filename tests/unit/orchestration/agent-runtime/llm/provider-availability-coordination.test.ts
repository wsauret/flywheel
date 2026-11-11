/**
 * Two independent Flywheel processes spending from one provider account.
 *
 * Each owner here is a separate `ProviderAvailability` with its own
 * `AvailabilityAuthority` handle on one database file, which is exactly what a
 * second process is: no shared memory, no shared projection, only the account
 * rows. The provider chain routes real requests through them, so what the
 * tests assert is what a user would see - which provider served, how many wire
 * calls each account state cost, and how many quota polls the account paid for.
 *
 * No credential and no network is involved: the quota subjects are digests of
 * a fake identity string, and every provider call is a local fake.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AccessProviderCandidate, accessProviderCandidateKey, type AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { streamAssistantTurn } from "../../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import {
  type AvailabilityAuthority,
  createAvailabilityAuthority,
} from "../../../../../src/infra/llm/availability-store.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import type { ProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { createFailoverClient, createRoutingDecisions } from "../../../../../src/orchestration/agent-runtime/llm/failover-client.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ModelClient, type ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { AllCandidatesExhaustedError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { requestEvents } from "./_provider-chain-harness.js";
import type { ProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "../_model-client.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-availability-coordination-"));

/** Every account authority these cases open. An open authority holds its own
 *  file open, and Windows refuses to remove a file anything still holds, so the
 *  teardown lets them all go before it removes the tree. */
const authorities: AvailabilityAuthority[] = [];

afterAll(async () => {
  for (const authority of authorities.splice(0)) await authority.dispose();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const MODEL = "gpt-5.5";

let accounts = 0;
function newAccountFile(): string {
  accounts += 1;
  return path.join(TMP, `account-${accounts}`, "availability.sqlite");
}

function candidate(provider: AccessProviderId, instanceId = "account-a"): AccessProviderCandidate {
  return provider.endsWith("_api")
    ? { kind: "singleton", providerId: provider, spendMode: "direct_api" }
    : { kind: "subscription", providerId: provider, instanceId, spendMode: "included" };
}


interface Owner {
  readonly availability: ProviderAvailability;
  readonly authority: AvailabilityAuthority;
}

interface OwnerOptions {
  readonly dbFile: string;
  readonly now: () => number;
  readonly instanceId?: string;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function createOwner({ dbFile, now, instanceId = "account-a", sleep }: OwnerOptions): Owner {
  const authority = createAvailabilityAuthority({ dbFile });
  authorities.push(authority);
  const owner = createProviderAvailability({ now, authority, ...(sleep === undefined ? {} : { sleep }) });
  const candidates = [candidate("chatgpt", instanceId), candidate("github_copilot", instanceId), candidate("openai_api", instanceId)];
  return { availability: owner.forCandidates("default", candidates), authority };
}

function fakeClient(
  provider: AccessProviderId,
  wire: AccessProviderId[],
  onWire: (provider: AccessProviderId) => void | Promise<void>,
): LLMClient {
  return { historyTarget: ownHistoryTarget,
    accessProvider: provider,
    modelFamily: "openai",
    model: MODEL,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 400_000,
    outputLimit: 64_000,
    supportsReasoning: true,
    async *streamWithTools() {
      wire.push(provider);
      await onWire(provider);
      yield { kind: "text_delta", text: provider, blockKey: "b1" };
      yield { kind: "done", stopReason: "end_turn" };
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  };
}

interface ChainOptions {
  readonly candidates: readonly AccessProviderCandidate[];
  readonly onWire?: (provider: AccessProviderId) => void | Promise<void>;
  readonly onBuild?: (provider: AccessProviderId) => void;
}

/** One chain client plus the record of which providers actually sent a
 *  request through it. */
function chainFor(owner: Owner, options: ChainOptions) {
  const wire: AccessProviderId[] = [];
  const client = createFailoverClient({
    model: MODEL,
    family: "openai",
    candidateAttributions: options.candidates.map((selected) => ({ candidate: selected, wireModelId: MODEL, dataUse: "standard" })),
    availability: owner.availability,
    routing: createRoutingDecisions(),
    build: async (attribution) => {
      const provider = attribution.candidate.providerId;
      options.onBuild?.(provider);
      const adapter = fakeClient(provider, wire, options.onWire ?? (() => {}));
      return { attempt: adapter, connect: async () => adapter };
    },
  });
  return { client, wire };
}

async function run(client: ModelClient): Promise<ProviderStreamEvent[]> {
  return requestEvents(client, { messages: [], tools: [], systemPrompt: stableSystemPrompt("s"), providerOptions: undefined });
}

/** Records which access provider each provider request the turn sends is
 *  attributed to. */
function recordingAudit() {
  const requests: AccessProviderId[] = [];
  const outcomes: string[] = [];
  const requestAudit: ProviderRequestAuditWriter = {
    recordRequest(input) {
      requests.push(input.attribution.accessProvider);
      return { requestId: `request-${requests.length}`, turn: input.turn };
    },
    recordResponse(_handle, input) { outcomes.push(input.outcome) },
    // An abandoned attempt settles through its own entry point, and the strict
    // path refuses a writer that has none.
    recordAbandonedResponse(_handle, input) { outcomes.push(input.outcome) },
    recordUsage() {},
    recordStreamStarted() {},
    recordStreamEvent() {},
    recordStreamCompleted() {},
  };
  return { requestAudit, requests, outcomes };
}

function rowState(authority: AvailabilityAuthority, selected: AccessProviderCandidate, window: string): string {
  const [row] = authority.snapshotFor([{ scope: "account", profileId: "default", provider: selected.providerId, candidateKey: accessProviderCandidateKey(selected), window }]).rows;
  return row?.state ?? "none";
}


describe("terminal quota across two owners", () => {
  test("defers exact-mode suppression until audit settlement, then a restarted owner skips the capped provider", async () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    const ownerA = createOwner({ dbFile, now: () => nowMs });
    const ownerB = createOwner({ dbFile, now: () => nowMs });
    const selected = candidate("chatgpt");
    const seenByB: string[] = [];
    const auditGate = Promise.withResolvers<void>();
    const auditStarted = Promise.withResolvers<void>();

    const a = chainFor(ownerA, {
      candidates: [selected, candidate("openai_api")],
      onBuild: (provider) => { seenByB.push(`${provider}:${rowState(ownerB.authority, selected, "primary")}`); },
      onWire: (provider) => {
        if (provider === "chatgpt") throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached"));
      },
    });
    const audit = recordingAudit();
    audit.requestAudit.recordResponse = async (_handle, input) => {
      audit.outcomes.push(input.outcome);
      auditStarted.resolve();
      await auditGate.promise;
    };
    audit.requestAudit.recordAbandonedResponse = audit.requestAudit.recordResponse;

    const pending = streamAssistantTurn({
      client: a.client,
      executionCwd: "/scratch",
      messages: [],
      tools: [],
      systemPrompt: stableSystemPrompt("s"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: audit.requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      turn: 1,
      messageCount: 0,
      estimatedContextTokens: 0,
      onEvent: () => {},
    });

    await auditStarted.promise;
    expect(a.wire).toEqual(["chatgpt"]);
    expect(seenByB).toEqual(["chatgpt:none"]);
    expect(rowState(ownerB.authority, selected, "primary")).toBe("none");

    auditGate.resolve();
    const result = await pending;
    expect(result.outcome.kind).toBe("ok");
    expect(a.wire).toEqual(["chatgpt", "openai_api"]);
    expect(rowState(ownerB.authority, selected, "primary")).toBe("exhausted");
    expect(audit.requests).toEqual(["chatgpt", "openai_api"]);
    expect(audit.outcomes).toEqual(["stream_error", "ok"]);

    const restarted = createOwner({ dbFile, now: () => nowMs });
    const replacement = chainFor(restarted, { candidates: [selected, candidate("openai_api")] });
    expect(await run(replacement.client)).toEqual([
      { kind: "text_delta", text: "openai_api", blockKey: "b1" },
      { kind: "done", stopReason: "end_turn" },
    ]);
    expect(replacement.wire).toEqual(["openai_api"]);
  });

  test("one owner claims a shared ChatGPT exhaustion generation", () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    const selected = candidate("chatgpt");
    const ownerA = createOwner({ dbFile, now: () => nowMs });
    const ownerB = createOwner({ dbFile, now: () => nowMs });

    const first = ownerA.availability.observeChatGptQuotaExhausted(selected, undefined);
    const second = ownerB.availability.observeChatGptQuotaExhausted(selected, undefined);

    expect([first.newlyExhausted, second.newlyExhausted].sort()).toEqual([false, true]);
  });

  test("restart before suppression may revisit the candidate and converges after settlement", async () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    const selected = candidate("chatgpt");
    const original = createOwner({ dbFile, now: () => nowMs });
    const first = chainFor(original, {
      candidates: [selected],
      onWire: () => { throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached")); },
    });

    const auditGate = Promise.withResolvers<void>();
    const auditStarted = Promise.withResolvers<void>();
    const audit = recordingAudit();
    audit.requestAudit.recordResponse = async () => { auditStarted.resolve(); await auditGate.promise; };
    const pending = streamAssistantTurn({
      client: first.client, executionCwd: "/scratch", messages: [], tools: [], systemPrompt: stableSystemPrompt("s"),
      reasoningEffort: undefined, signal: undefined, cacheRetention: "1h",
      providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: audit.requestAudit,
      staleMasking: undefined, interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      requestContext: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 0, onEvent: () => {},
    });
    const rejected = pending.then(() => undefined, (error: unknown) => error);
    await auditStarted.promise;

    const restartedBeforeSettlement = createOwner({ dbFile, now: () => nowMs });
    const revisited = chainFor(restartedBeforeSettlement, {
      candidates: [selected],
      onWire: () => { throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached")); },
    });
    await expect(run(revisited.client)).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(revisited.wire).toEqual(["chatgpt"]);

    auditGate.resolve();
    expect(await rejected).toBeInstanceOf(AllCandidatesExhaustedError);
    const restartedAfterSettlement = createOwner({ dbFile, now: () => nowMs });
    const skipped = chainFor(restartedAfterSettlement, { candidates: [selected] });
    await expect(run(skipped.client)).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(skipped.wire).toEqual([]);
  });
  test("a stale owner claims the next episode after another owner publishes recovery", () => {
    const dbFile = newAccountFile();
    let nowMs = Date.now();
    const selected = candidate("chatgpt");
    const ownerA = createOwner({ dbFile, now: () => nowMs });
    const ownerB = createOwner({ dbFile, now: () => nowMs });

    expect(ownerA.availability.observeChatGptQuotaExhausted(selected, undefined).newlyExhausted).toBe(true);
    nowMs += 5 * 60_000 + 1;
    ownerB.availability.refreshProjection();
    const probe = ownerB.availability.claimQuotaProbe(selected);
    if (probe === undefined) throw new Error("expected the recovery probe");
    expect(ownerB.availability.markQuotaLive(selected, probe)).toBe(true);

    const next = ownerA.availability.observeChatGptQuotaExhausted(selected, undefined);

    expect(next.newlyExhausted).toBe(true);
    expect(rowState(ownerB.authority, selected, "primary")).toBe("exhausted");
  });

  test("a suppression outlives the process that observed it", async () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    createOwner({ dbFile, now: () => nowMs }).availability.observeChatGptQuotaExhausted(candidate("chatgpt"), undefined);

    const restarted = createOwner({ dbFile, now: () => nowMs });
    const chain = chainFor(restarted, { candidates: [candidate("chatgpt"), candidate("openai_api")] });

    await run(chain.client);
    expect(chain.wire).toEqual(["openai_api"]);
  });

  test("another account on the same file is unaffected", async () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    createOwner({ dbFile, now: () => nowMs }).availability.observeChatGptQuotaExhausted(candidate("chatgpt"), undefined);

    const other = createOwner({ dbFile, now: () => nowMs, instanceId: "account-b" });
    const chain = chainFor(other, { candidates: [candidate("chatgpt"), candidate("openai_api")] });

    await run(chain.client);
    expect(chain.wire).toEqual(["chatgpt"]);
  });

  test("a chain whose every candidate the account cannot pay for is rejected without a wire call", async () => {
    const dbFile = newAccountFile();
    const nowMs = Date.now();
    const ownerA = createOwner({ dbFile, now: () => nowMs });
    ownerA.availability.observeChatGptQuotaExhausted(candidate("chatgpt"), undefined);
    ownerA.availability.markQuotaExhausted(candidate("openai_api"));

    const ownerB = createOwner({ dbFile, now: () => nowMs });
    const chain = chainFor(ownerB, { candidates: [candidate("chatgpt"), candidate("openai_api")] });

    const error = await run(chain.client).then(() => undefined).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AllCandidatesExhaustedError);
    expect(chain.wire).toEqual([]);
  });

  test("a peer lease prevents duplicate wire I/O until its owner publishes recovery", async () => {
    const dbFile = newAccountFile();
    let nowMs = Date.now();
    const selected = candidate("openai_api");
    const ownerA = createOwner({ dbFile, now: () => nowMs });
    ownerA.availability.markQuotaExhausted(selected);
    nowMs += 5 * 60_000 + 1;
    ownerA.availability.refreshProjection();
    const probe = ownerA.availability.claimQuotaProbe(selected);
    if (probe === undefined) throw new Error("expected owner A to hold the recovery probe");

    const sleepGate = Promise.withResolvers<void>();
    const ownerB = createOwner({ dbFile, now: () => nowMs, sleep: () => sleepGate.promise });
    const serving = chainFor(ownerB, { candidates: [selected] });
    const request = run(serving.client);
    await Promise.resolve();
    await Promise.resolve();

    expect(serving.wire).toEqual([]);
    expect(ownerA.availability.markQuotaLive(selected, probe)).toBe(true);
    sleepGate.resolve();

    expect(await request).toEqual([
      { kind: "text_delta", text: "openai_api", blockKey: "b1" },
      { kind: "done", stopReason: "end_turn" },
    ]);
    expect(serving.wire).toEqual(["openai_api"]);
  });
});
