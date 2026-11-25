import { Effect, Scope } from "effect"
import type { AccessProviderCandidateAttribution } from "../../../infra/providers/llm/access/access-provider.js"
import { ApiError } from "../../agent-runtime/llm/routing/runtime-errors.js"
import { providerAdapter, type AccessProviderBuild } from "../../agent-runtime/llm/routing/client-factory.js"
import { describeProvider, requireModelMetadata } from "../../agent-runtime/llm/provider-description.js"
import { withStreamAttempt } from "../../agent-runtime/llm/stream/stream-attempt.js"
import { STREAM_IDLE_TIMEOUT_PATIENT_MS } from "../../agent-runtime/llm/stream/stream-liveness.js"
import { FUNCTION_TOOL_PRESENTATION, presentToolHistory, type LLMClient, type ProviderAdapter, type ProviderStreamEvent, type ServingAttempt, type StreamOptions, type ToolPresentation } from "../../agent-runtime/llm/types.js"
import { createBridge, type Bridge, type BridgeGate } from "./request/bridge.js"
import { antigravityContextLimits } from "./catalog/context-limits.js"
import { sessionEngineDemand } from "./engine/engine-demand.js"
import type { EngineProcess } from "./engine/engine-process.js"
import type { EngineLease, EnginePlace, EngineRegistry } from "./engine/engine-registry.js"
import { textHistoryTarget } from "./request/history-text.js"
import { loginFailure, type LoginObservations } from "./login/login-status.js"
import { GOOGLE_ANTIGRAVITY_LABEL } from "./names.js"
import { engineToolName } from "./engine/private-home.js"
import type { PlanLimits } from "./request/request-plan.js"
import { fitsEngineWire, projectToolResult, TOOL_RESULT_WIRE_BYTES } from "./tools/result-projection.js"
import { projectTools, type McpToolDeclaration } from "./tools/tool-projection.js"
import { createTransportAudit } from "./request/transport-audit.js"

/** What the module's runtime gives each client: the process-wide engine registry, the login directory of each
 *  account, the step gate of each login, and the process's login observations, which hear how each request of a
 *  login ended. */
export interface AntigravityClientDeps {
  readonly registry: EngineRegistry<EngineProcess>
  readonly loginDir: (accountId: string) => string
  readonly gate: (loginDir: string) => BridgeGate
  readonly observations: Pick<LoginObservations, "recordRequest">
}

// agy fails every prompt of a session whose system text is over the model's budget: measured on agy 1.5.14 against
// the fake host, 760,000 bytes worked and 780,000 failed on a 256K family, and 1,400,000 bytes worked on a 512K one.
const APPEND_BYTES_256K = 760_000
const APPEND_BYTES_512K = 1_400_000
// agy cuts a prompt after 192,000 bytes; Flywheel leaves room for agy's own wrapper of the prompt.
const PROMPT_BYTES = 190_000
// The guard keeps a session this far below agy's own compaction threshold (plan P9).
const THRESHOLD_MARGIN_TOKENS = 8_000

function planLimits(model: string): PlanLimits {
  const limits = antigravityContextLimits(model)
  if (limits === undefined) throw new ApiError({ message: `The ${GOOGLE_ANTIGRAVITY_LABEL} engine has no qualified context window for ${model}`, recovery: { kind: "none" } })
  return { threshold: limits.threshold, margin: THRESHOLD_MARGIN_TOKENS, byteCap: limits.threshold > 256_000 ? APPEND_BYTES_512K : APPEND_BYTES_256K, promptByteCap: PROMPT_BYTES }
}

const ENGINE_TOOL_PREFIX = engineToolName("")

/** agy shows the model each of Flywheel's tools under its MCP server's prefix and calls Flywheel's server with the
 *  plain name, so only the name of a call in history maps. */
const enginePresentation: ToolPresentation = Object.freeze({
  ...FUNCTION_TOOL_PRESENTATION,
  format: "mcp-function-schema",
  wireName: engineToolName,
  canonicalName: (wireName: string) => wireName.startsWith(ENGINE_TOOL_PREFIX) ? wireName.slice(ENGINE_TOOL_PREFIX.length) : wireName,
})

function toolKey(tools: readonly McpToolDeclaration[]): string {
  return JSON.stringify(tools.map((tool) => tool.name).toSorted())
}

/**
 * Builds the Google Antigravity client of one candidate: every model request goes through the unmodified `agy acp`
 * engine of the request's chat tree on the candidate's login (ARCH-PROVIDERS-086). The client's bridge, and the lease
 * of the engine that it holds, live in the scope of its provider-session lifetime, so a client for another route that
 * replaces this one ends them; staging and planning start nothing. Every agent of one chat tree, the root and each
 * descendant, names the tree by its root session id, so they share one engine process per login. A request of a
 * session that a client shows can start that engine ahead of the request (`anticipate`, ARCH-PROVIDERS-068).
 */
export function createAntigravityClient(build: AccessProviderBuild, deps: AntigravityClientDeps): ProviderAdapter {
  const candidate = build.candidate
  if (candidate.kind !== "subscription") throw new ApiError({ message: `The ${GOOGLE_ANTIGRAVITY_LABEL} provider requires a Google Antigravity login`, recovery: { kind: "none" } })
  const lifetime = build.providerSessionLifetime
  const accountId = candidate.instanceId
  const loginDir = deps.loginDir(accountId)
  const treeRootSessionId = lifetime.treeRootSessionId ?? lifetime.providerSessionKey
  const place = (tools: readonly McpToolDeclaration[]): EnginePlace => ({ treeRootSessionId, loginDir, accountId, tools })
  const accessProvider = candidate.providerId
  const historyTarget = textHistoryTarget({ accessProvider, provider: "google", api: "google-generative-ai", model: build.wireModelId })

  // Each request describes and limits itself on its own admission's metadata (ARCH-PROVIDERS-023).
  const describe = async (attribution: AccessProviderCandidateAttribution): Promise<ServingAttempt> => ({
    ...await describeProvider(build.model, {
      accessProvider, protocol: "google", providerHint: "google", resolvedModelMetadata: requireModelMetadata(build.model, attribution.resolvedModelMetadata),
    }),
    toolPresentation: enginePresentation,
    anticipatesRequests: true,
    toolResultWireBytes: TOOL_RESULT_WIRE_BYTES,
  })

  return providerAdapter(build, describe, async () => {
    let held: { readonly key: string; readonly lease: EngineLease<EngineProcess> } | undefined
    const bridge = createBridge({
      async serving(tools) {
        const key = toolKey(tools)
        const previous = held
        const current = previous?.key === key ? previous : { key, lease: deps.registry.lease(place(tools)) }
        held = current
        try {
          const engine = await current.lease.engine()
          return { engine, gate: deps.gate(engine.loginDir) }
        } finally {
          // The new surface's lease holds the place before the old one ends, so a shared engine never closes between.
          if (previous !== undefined && previous !== current) void previous.lease.release()
        }
      },
      async probeServing() {
        // A place of its own, whose process declares no tool of Flywheel and ends with the probe.
        const lease = deps.registry.lease({ treeRootSessionId: `${treeRootSessionId}:gate-probe`, loginDir, accountId, tools: [] })
        try {
          const engine = await lease.engine()
          return { engine, gate: deps.gate(engine.loginDir), release: () => lease.release() }
        } catch (error) {
          await lease.release()
          throw error
        }
      },
      limits: planLimits,
      wireName: engineToolName,
      audit: createTransportAudit(),
    })
    Effect.runSync(Scope.addFinalizer(lifetime.scope, Effect.promise(async () => {
      await bridge.close()
      await held?.lease.release()
    })))
    return bridge
  }, async (bridge: Bridge, { attribution }): Promise<LLMClient> => ({
      ...await describe(attribution),
      historyTarget: () => historyTarget,
      async anticipate(options: StreamOptions) {
        if (lifetime.demand === undefined) return undefined
        const tools = projectTools(options.tools)
        return sessionEngineDemand(lifetime.demand).claimEngine(JSON.stringify([treeRootSessionId, loginDir]), () => deps.registry.lease(place(tools)))
      },
      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        const effort = options.reasoningEffort === undefined || options.reasoningEffort === "off" ? undefined : options.reasoningEffort
        yield* withStreamAttempt<ProviderStreamEvent>(async function* (attempt) {
          const liveness = attempt.armLiveness({ label: "llm-google-antigravity", provider: GOOGLE_ANTIGRAVITY_LABEL, telemetry: options.telemetry, idleTimeoutMs: STREAM_IDLE_TIMEOUT_PATIENT_MS })
          try {
            yield* bridge.stream({
              systemPrompt: options.systemPrompt,
              messages: presentToolHistory(options.messages, enginePresentation),
              tools: projectTools(options.tools),
              model: build.wireModelId,
              ...effort === undefined ? {} : { effort },
              estimatedTokens: options.estimatedContextTokens ?? 0,
              signal: attempt.signal,
              liveness,
              ...options.onDispatch === undefined ? {} : { onDispatch: options.onDispatch },
              async projectResult(content, call) {
                if (fitsEngineWire(content)) return content
                // The agent loop names the owners of every request that delivers a result; the project root stands in otherwise.
                const savedOutputPath = await options.savedOutputPath?.(call.toolUseId)
                return projectToolResult(content, {
                  executionCwd: options.executionCwd ?? build.projectRoot, projectRoot: build.projectRoot,
                  artifactScopeId: options.artifactScopeId ?? lifetime.providerSessionKey, toolName: call.toolName,
                  ...savedOutputPath === undefined ? {} : { savedOutputPath },
                })
              },
            })
          } catch (error) {
            // Recorded before the failure reaches the walk, so a refused login has its question when the walk asks.
            const failure = loginFailure(error instanceof Error ? error : undefined, false)
            if (failure !== undefined) deps.observations.recordRequest(loginDir, failure)
            throw error
          }
          deps.observations.recordRequest(loginDir, "served")
        }, options)
      },
  }))
}
