/**
 * Factory for creating the three warm pools used during workflow execution:
 * dispatcher, evaluator, and worker.
 *
 * Extracted from workflow-runner.ts to keep file sizes manageable.
 */

import { WarmPool } from "./warm-pool"
import { BunProcessSpawner } from "../subprocess/bun-spawner"
import { resolveTierConfigs } from "../../config/loader"
import { getEngine } from "../core/registry"
import { createEnvFilter } from "../subprocess/env-filter"
import { buildDispatcherSystemPrompt } from "../../../workflows/dispatcher/system-prompt"
import type { WorkflowDeps } from "../workflow-deps"
import type { SpawnResult } from "../subprocess/spawner"
import type { RawSpawnedProcess } from "../subprocess/stream-pipeline"

export interface WarmPools {
  dispatcher: WarmPool<SpawnResult>
  evaluator: WarmPool<SpawnResult> | null
  subprocess: WarmPool<RawSpawnedProcess> | null
}

/** Create warm pools for dispatcher, evaluator, and subprocess. */
export function createWarmPools(
  deps: WorkflowDeps,
  cwd: string,
  subprocessCwd?: string,
): WarmPools {
  const tiers = resolveTierConfigs(deps.config)
  const engine = getEngine(deps.config.engine)
  const env = createEnvFilter().filter(process.env as Record<string, string | undefined>)
  const spawnOpts = { stdinPipe: true as const, cwd, env }

  const dCmd = engine.buildCommand({
    tools: "Write", model: tiers.dispatcher?.model || "sonnet",
    effort: tiers.dispatcher?.effort || "low", systemPrompt: buildDispatcherSystemPrompt(),
  })
  const dispatcher = new WarmPool<SpawnResult>({
    label: "dispatcher",
    spawn: () => deps.spawner.spawn(dCmd.command, dCmd.args, spawnOpts),
  })

  let evaluator: WarmPool<SpawnResult> | null = null
  if (!deps.config.skip_evaluation) {
    const eCmd = engine.buildCommand({
      tools: "Read,Bash,Write,Grep,Glob", model: tiers.evaluator?.model || "sonnet",
      effort: tiers.evaluator?.effort || "low",
    })
    evaluator = new WarmPool<SpawnResult>({
      label: "evaluator",
      spawn: () => deps.spawner.spawn(eCmd.command, eCmd.args, spawnOpts),
    })
  }

  // Subprocess pool — uses spawnRaw() for pre-warming with unconsumed streams.
  // Only available when the spawner supports raw spawning (BunProcessSpawner).
  let subprocess: WarmPool<RawSpawnedProcess> | null = null
  if (deps.spawner instanceof BunProcessSpawner) {
    const wCmd = engine.buildCommand({
      model: deps.config.subprocess?.model ?? deps.config.model,
    })
    const rawSpawner = deps.spawner as BunProcessSpawner
    const rawSpawnOpts = { stdinPipe: true as const, cwd: subprocessCwd ?? cwd, env }

    subprocess = new WarmPool<RawSpawnedProcess>({
      label: "subprocess",
      spawn: () => Promise.resolve(rawSpawner.spawnRaw(wCmd.command, wCmd.args, rawSpawnOpts)),
      getPid: (raw) => raw.proc.pid,
      getExitPromise: (raw) => raw.proc.exited,
      killProc: (raw) => {
        raw.unregister()
        try { raw.proc.kill() } catch { /* already dead */ }
      },
    })
  }

  return { dispatcher, evaluator, subprocess }
}
