import { WarmPool } from "./warm-pool.js";
import { buildCommand } from "../engine.js";
import { BunProcessSpawner } from "../subprocess/bun-spawner.js";
import { createEnvFilter } from "../subprocess/env-filter.js";
import { buildDispatcherSystemPrompt } from "../../../../../workflows/dispatcher/system-prompt.js";
import { resolveToolProfile } from "../../../core/tool-resolution.js";
import type { SpawnResult } from "../subprocess/spawner.js";
import type { NDJSONEvent } from "../../../../../infra/ndjson-event-types.js";

interface TierPoolConfig {
  model?: string;
  effort?: string;
  /** Called for each NDJSON event produced by the tier's engine process. */
  onNDJSONEvent?: (event: NDJSONEvent) => void;
}

export interface ClaudeWarmPools {
  dispatcher: WarmPool<SpawnResult> | null;
  evaluator: WarmPool<SpawnResult> | null;
  shutdown(): Promise<void>;
}

interface CreateWarmPoolsOptions {
  cwd: string;
  /** Omit to skip pool for a tier (e.g., tier uses a non-pooling engine). */
  dispatcher?: TierPoolConfig;
  evaluator?: TierPoolConfig;
}

export function createClaudeWarmPools(opts: CreateWarmPoolsOptions): ClaudeWarmPools {
  const env = createEnvFilter().filter(process.env as Record<string, string | undefined>);
  const spawner = new BunProcessSpawner();
  const spawnOpts = { stdinPipe: true as const, cwd: opts.cwd, env };

  let dispatcher: WarmPool<SpawnResult> | null = null;
  if (opts.dispatcher) {
    const dCmd = buildCommand({
      tools: resolveToolProfile("claude", "dispatcher_handoff"),
      model: opts.dispatcher.model ?? "sonnet",
      effort: opts.dispatcher.effort ?? "low",
      systemPrompt: buildDispatcherSystemPrompt(),
    });
    const dSpawnOpts = opts.dispatcher.onNDJSONEvent
      ? { ...spawnOpts, onNDJSONEvent: opts.dispatcher.onNDJSONEvent }
      : spawnOpts;
    dispatcher = new WarmPool<SpawnResult>({
      label: "dispatcher",
      spawn: () => spawner.spawn(dCmd.command, dCmd.args, dSpawnOpts),
    });
  }

  let evaluator: WarmPool<SpawnResult> | null = null;
  if (opts.evaluator) {
    const eCmd = buildCommand({
      tools: resolveToolProfile("claude", "evaluator_verification"),
      model: opts.evaluator.model ?? "sonnet",
      effort: opts.evaluator.effort ?? "low",
    });
    const eSpawnOpts = opts.evaluator.onNDJSONEvent
      ? { ...spawnOpts, onNDJSONEvent: opts.evaluator.onNDJSONEvent }
      : spawnOpts;
    evaluator = new WarmPool<SpawnResult>({
      label: "evaluator",
      spawn: () => spawner.spawn(eCmd.command, eCmd.args, eSpawnOpts),
    });
  }

  return {
    dispatcher,
    evaluator,
    async shutdown() {
      await Promise.all([
        dispatcher?.shutdown(),
        evaluator?.shutdown(),
      ]);
    },
  };
}
