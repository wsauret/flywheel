/**
 * Factory for creating the three warm pools used during workflow execution:
 * dispatcher, evaluator, and worker.
 *
 * Single-use factory justified by SRP: tier resolution, env filtering, and
 * three distinct spawn pipelines form a cohesive concern. Inlining would
 * force workflow-runner to manage pool construction alongside execution.
 */

import { WarmPool } from "./warm-pool"
import { resolveTierConfigs } from "../../config/schema"
import { getEngine } from "../core/registry"
import { createEnvFilter } from "../subprocess/env-filter"
import { buildDispatcherSystemPrompt } from "../../../workflows/dispatcher/system-prompt"
import type { WorkflowDeps } from "../workflow-deps"
import type { SpawnResult } from "../subprocess/spawner"
import type { RawSpawnedProcess } from "../subprocess/stream-pipeline"

export interface WarmPools {
  dispatcher: WarmPool<SpawnResult>
  evaluator: WarmPool<SpawnResult>
  subprocess: WarmPool<RawSpawnedProcess> | null
}

/**
 * Create warm pools for dispatcher, evaluator, and subprocess.
 *
 * When `mode` is "sprint", tier configs are resolved with sprint overrides
 * from [sprint.worker], [sprint.evaluator], [sprint.dispatcher] in the TOML.
 */
export function createWarmPools(
  deps: WorkflowDeps,
  cwd: string,
  subprocessCwd?: string,
  mode?: "sprint",
): WarmPools {
  const tiers = resolveTierConfigs(deps.config, mode)
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

  const eCmd = engine.buildCommand({
    tools: "Read,Bash,Write,Grep,Glob", model: tiers.evaluator?.model || "sonnet",
    effort: tiers.evaluator?.effort || "low",
  })
  const evaluator = new WarmPool<SpawnResult>({
    label: "evaluator",
    spawn: () => deps.spawner.spawn(eCmd.command, eCmd.args, spawnOpts),
  })

  // Subprocess pool — uses spawnRaw() for pre-warming with unconsumed streams.
  let subprocess: WarmPool<RawSpawnedProcess> | null = null
  if (deps.spawner.spawnRaw) {
    const wCmd = engine.buildCommand({
      model: tiers.subprocess?.model ?? deps.config.model,
      effort: tiers.subprocess?.effort ?? undefined,
    })
    const spawnRaw = deps.spawner.spawnRaw.bind(deps.spawner)
    const rawSpawnOpts = { stdinPipe: true as const, cwd: subprocessCwd ?? cwd, env }

    subprocess = new WarmPool<RawSpawnedProcess>({
      label: "subprocess",
      spawn: () => Promise.resolve(spawnRaw(wCmd.command, wCmd.args, rawSpawnOpts)),
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
