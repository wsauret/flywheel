import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js";
import { createSessionBudgetStore } from "../../../../src/orchestration/session/budget-store.js";
import { readBudgetSummaryFromReader } from "../../../../src/orchestration/session/budget-summary.js";
import type { BudgetLimits } from "../../../../src/workflows/budget";
import type { EmitFn } from "../../../../src/infra/event-bus";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import type { SessionBudgetStore } from "../../../../src/orchestration/session/budget-store-types.js";

/** No-op emitter for tests that exercise budget APIs but ignore emissions. */
export const noopEmitter: EmitFn = () => {};

export const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-budget-test-${process.pid}-${Date.now()}`,
);

export function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Build a result RuntimeEvent with total_cost_usd and token counts. */
export function resultEvent(
  costUsd: number,
  inputTokens = 1000,
  outputTokens = 500,
  cacheRead = 0,
  cacheCreation = 0,
): RuntimeEvent {
  return {
    type: "model.turn.completed",
    data: {
      type: "model.turn.completed",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
      billed_cost_usd: costUsd,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  };
}

/** Build a result event with no usage field (cost only). */
export function resultNoUsage(costUsd: number): RuntimeEvent {
  return {
    type: "model.turn.completed",
    data: {
      type: "model.turn.completed",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
      billed_cost_usd: costUsd,
    },
  };
}

/** Build a result event with no cost data (should be ignored). */
export function resultNoCost(): RuntimeEvent {
  return {
    type: "model.turn.completed",
    data: {
      type: "model.turn.completed",
      subtype: "success",
      session_id: "abc-123",
    },
  };
}

/** Build a v3 cumulative historical usage fact for one runner stream. */
export function usageEvent(
  costUsd: number,
  inputTokens = 0,
  outputTokens = 0,
  parentToolUseId?: string,
  billedUsd = costUsd,
) {
  return {
    type: "model.usage.measured" as const,
    version: 3 as const,
    actor: "provider" as const,
    payload: {
      totalCostUsd: costUsd,
      billedCostUsd: billedUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  };
}

export function committedUsageEvent(options: { attemptId: string; classification: "real_spend" | "subscription_equivalent"; price: { kind: "priced"; estimatedUsd: number; rateCard: { [key: string]: number }; provenance: "live" } | { kind: "unavailable"; reason: string }; inputTokens?: number; outputTokens?: number; cacheWrite1h?: number }): RuntimeEvent {
  return {
    type: "model.usage.measured",
    data: {
      usage_entry: {
        attemptId: options.attemptId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        profileId: "profile-1",
        attribution: { kind: "candidate", providerId: "anthropic_api" },
        spendMode: options.classification === "real_spend" ? "direct_api" : "included",
        credentialLineage: "00000000-0000-4000-8000-000000000099",
        model: "test-model",
        classification: options.classification,
        tokens: {
          input: options.inputTokens ?? 10, output: options.outputTokens ?? 5, cacheRead: 0, cacheWrite: options.cacheWrite1h ?? 0,
          ...(options.cacheWrite1h === undefined ? {} : { cacheWrite1h: options.cacheWrite1h }), reasoning: 0,
        },
        price: options.price,
        currency: "USD", coverage: "complete",
      },
      budget_stream_id: "session-1",
    },
  }
}

/** Build an assistant event (non-cost, should be ignored by the budget store). */
export function assistantEvent(text: string): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: {
      type: "model.assistant_message.recorded",
      message: { content: [{ type: "text", text }] },
    },
  };
}

/** Default unlimited budget limits. */
export function unlimitedLimits(overrides?: Partial<BudgetLimits>): BudgetLimits {
  return {
    max_invocations: 0,
    max_tokens: null,
    max_wall_clock_minutes: null,
    max_cost_usd: null,
    ...overrides,
  };
}

/** Wait for debounce to settle. */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function makeSessionStores(baseDir: string, sessionId: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) });
  return { store, projectionReader: asAsyncEventReadSurface(store), writer, record: writer.record, close: () => store.close() };
}

export function makeSessionBudgetStore(baseDir: string, sessionId: string, opts: { emitter?: EmitFn; budgetLimits?: BudgetLimits } = {}): SessionBudgetStore {
  const stores = makeSessionStores(baseDir, sessionId);
  const budgetStore = createSessionBudgetStore({
    sessionId,
    emitter: opts.emitter ?? noopEmitter,
    budgetLimits: opts.budgetLimits,
    reader: asAsyncEventReadSurface(stores.store),
    recorder: stores.record,
  });
  const dispose = budgetStore.dispose;
  return {
    ...budgetStore,
    dispose(): void {
      dispose();
      stores.writer.dispose();
      stores.close();
    },
  };
}

/** Read a budget summary through an ephemeral store, the way tests reopen the projection. */
export async function readBudgetSummary(sessionId: string, baseDir: string): ReturnType<typeof readBudgetSummaryFromReader> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  try {
    return await readBudgetSummaryFromReader(asAsyncEventReadSurface(store), sessionId);
  } finally {
    store.close();
  }
}

export function cleanupTmpRoot(): void {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}
