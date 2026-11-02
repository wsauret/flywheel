import { Effect, Exit, Redacted, Scope } from "effect";
import { ApiError } from "../../agent-runtime/errors.js";
import { createAnthropicAdapter, prepareAnthropicRequest } from "../../agent-runtime/llm/anthropic.js";
import { RouteUnavailableError } from "../../agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../agent-runtime/llm/provider-failure.js";
import { engineModelId, createClaudeReminders, environmentFacts } from "../../agent-runtime/llm/claude-reminders.js";
import { credentialForCandidate, stagedProviderClient, type AccessProviderBuild } from "../../agent-runtime/llm/client-factory.js";
import { describeProvider } from "../../agent-runtime/llm/provider-description.js";
import { FUNCTION_TOOL_PRESENTATION, trailingRuntimeNotices, type StagedProviderClient, type ToolPresentation } from "../../agent-runtime/llm/types.js";
import { processUsageReadings } from "./account-usage.js";
import { makeBridge } from "./bridge.js";
import type { BridgeConfig } from "./bridge-state.js";
import { cliLaunch, observationsOf, type ClaudeAgentSdkSeams } from "./cli-launch.js";
import { cliLogin } from "./cli-login.js";
import { extraUsageNotice, extraUsageOf } from "./extra-usage-guard.js";
import { inPlaceGate, runInPlaceSelfTest, type InPlaceGate, type SelfTestConfig } from "./in-place-check.js";
import { engineShell } from "./engine-environment.js";
import { CLAUDE_AGENT_SDK_LABEL, CLAUDE_AGENT_SDK_LOGIN_COMMAND, CLAUDE_AGENT_SDK_PROVIDER_ID, TOOL_MCP_PREFIX } from "./names.js";
import { silentVersions } from "./stderr-signals.js";
import { createHostLauncher, createQueryLauncher } from "./query-launcher.js";
import { createHostedAgent, type HostedAgent } from "./agent-host/agent-bridge.js";
import { createHostedAgentEntries } from "./agent-host/engine-text.js";
import { cliView } from "./cli-view.js";
import { processAgentHosts } from "./agent-host/host-registry.js";
import { accessProviderAccountKey } from "../../../infra/llm/access-provider.js";

/** The gate that runs the fake-host self-test of each listed CLI version once per process for the bridge's model. */
function selfTestedGate(config: SelfTestConfig): InPlaceGate {
  return inPlaceGate((cliVersion) => runInPlaceSelfTest(config, cliVersion), engineModelId(config.wireModelId, config.contextLimit));
}

/** The CLI versions whose debug output this process found silent, which every bridge of the process refuses. */
const processSilentVersions = silentVersions();

/**
 * The CLI declares Flywheel's tools under the `runtime` MCP server's prefix and applies its own tool order and
 * system prefix, so the bridge maps only the name. The shared request path already sends each definition in the
 * engine's text form (`tool-definition-text.ts`), so the engine's own rewrite changes nothing. Everything else the
 * adapter sends is canonical.
 */
const bridgePresentation: ToolPresentation = Object.freeze({
  ...FUNCTION_TOOL_PRESENTATION,
  format: "mcp-function-schema",
  wireName: (name: string) => `${TOOL_MCP_PREFIX}${name}`,
  canonicalName,
});

/** A model can write the prefix more than once (observed 2026-10-25: `mcp__runtime__mcp__runtime__ask_user`), so every leading copy goes. */
function canonicalName(wireName: string): string {
  let name = wireName;
  while (name.startsWith(TOOL_MCP_PREFIX)) name = name.slice(TOOL_MCP_PREFIX.length);
  return name;
}

/**
 * Builds the Agent SDK bridge client for one candidate. Canonical history carries the shared Claude
 * reminders, as on the native Anthropic paths; the CLI writes its own wire copy of them. The credential is the
 * account's external login, which names only the absolute `CLAUDE_CONFIG_DIR` where the CLI keeps it. Connecting fails
 * closed without the runtime generation's launcher, so the CLI is never a process that Flywheel does not own.
 * The client keeps its bridge, and the CLI it holds, in the scope of its provider-session lifetime, which the runner
 * closes when a client for a different route replaces this one; staging and planning start nothing. Only the paid (automatic) spend mode,
 * which the person's paid-use permission admits, lets the account serve requests from Claude extra usage; the
 * included spend mode's bridge stops the account on any evidence of it and raises the person's notice through the
 * notify seam of the composition that built the client (`AccessProviderBuild.notify`); a shared host keeps the seam of
 * the client that opened it, which every client of its tree shares. Each CLI report of the account's plan windows becomes the account's
 * usage reading in this process, which the usage reader reads. A client whose lifetime names a shared host runs its
 * conversation as an agent of the chat tree's shared agent host (agent-host/agent-bridge.ts), which also records the
 * engine's own text in canonical history.
 */
export async function createClaudeAgentSdkClient(build: AccessProviderBuild, seams: ClaudeAgentSdkSeams = {}): Promise<StagedProviderClient> {
  const candidate = build.candidate;
  if (candidate.kind !== "subscription") throw new ApiError({ message: `The ${CLAUDE_AGENT_SDK_LABEL} provider requires a Claude login`, recovery: { kind: "none" } });
  const described = await describeProvider(build.model, {
    accessProvider: CLAUDE_AGENT_SDK_PROVIDER_ID, protocol: "anthropic", providerHint: "anthropic",
    resolvedModelMetadata: build.attribution.resolvedModelMetadata,
  });
  const contextLimit = described.totalContextLimit ?? described.contextLimit;
  const sharedHost = build.providerSessionLifetime.sharedHost;
  let hosted: HostedAgent | undefined;
  const info = build.attribution.resolvedModelMetadata ?? null;
  return stagedProviderClient(build, {
    ...described, toolPresentation: bridgePresentation,
    // The bridge starts the engine of an anticipated request, and a hosted agent leases its host.
    anticipatesRequests: true,
    // The CLI joins every system block after its boundary into one cached
    // block, so the conversations share only the tools and the stable tier
    // (query-launcher.ts `cliSystemPrompt`). A hosted agent's definition holds
    // the stable and session tiers, and its conversation tier is an entry of
    // its first message, so hosted siblings share both tiers.
    ...(sharedHost === undefined ? { sharedPromptPrefix: "stable" as const } : {}),
    messagesToAppend: createClaudeReminders(build.wireModelId, contextLimit),
    ...(sharedHost === undefined ? {} : {
      // The request as the adapter prepares it for the bridge (`createAnthropicAdapter`). A request that no host
      // serves is no dispatch. Before the client connected no agent runs, so a request that a host serves starts one.
      requestEntries: createHostedAgentEntries((request) => {
        const prepared = prepareAnthropicRequest({
          accessProvider: CLAUDE_AGENT_SDK_PROVIDER_ID, model: build.wireModelId, wireModel: build.wireModelId, info, contextLimit: info?.contextLimit,
          options: request, presentation: bridgePresentation, hosted: true,
        });
        if (!prepared.historyTarget.sharedHost) return false;
        return hosted === undefined || hosted.dispatches(cliView(prepared.params, prepared.origins, build.projectRoot), { requestContext: request.requestContext, runtimeNotices: trailingRuntimeNotices(request.messages) });
      }),
    }),
  }, async () => {
    const lifetime = build.providerSessionLifetime;
    const launch = cliLaunch(credentialForCandidate(build.connection, candidate), build.launcher, seams);
    switch (launch.kind) {
      case "no-login": throw new ApiError({ message: `No Claude login in the active auth profile. Run: ${CLAUDE_AGENT_SDK_LOGIN_COMMAND}`, recovery: { kind: "none" } });
      case "no-launcher": throw new ApiError({ message: `The ${CLAUDE_AGENT_SDK_LABEL} provider has no launch authority for the Claude engine`, recovery: { kind: "none" } });
      // An engine that this machine cannot run hands the request to the next candidate, as for a route that is down.
      case "no-host": throw normalizeProviderAttemptFailure(new RouteUnavailableError(`The ${CLAUDE_AGENT_SDK_LABEL} provider cannot start the Claude engine for this OS account: ${launch.reason}`));
      case "ready": break;
    }
    const createLauncher = seams.createLauncher ?? createQueryLauncher;
    const launchQuery = createLauncher(launch.config);
    const login = build.connection.subscriptionCredentials.get(candidate.providerId)?.find((entry) => entry.instanceId === candidate.instanceId);
    const readings = seams.usageReadings ?? processUsageReadings;
    const selfTest: SelfTestConfig = { launcher: launch.config, launchQuery: createLauncher, wireModelId: build.wireModelId, contextLimit };
    const config: BridgeConfig = {
      launchQuery, configDir: launch.config.configDir, inPlace: (seams.inPlaceGate ?? selfTestedGate)(selfTest),
      openingEnvironment: environmentFacts, engineShell: () => engineShell(launch.config), silentVersions: processSilentVersions, projectRoot: build.projectRoot, wireModelId: build.wireModelId, contextLimit,
      recordModelRefusal: (refusal) => { build.recordModelRefusal(build.wireModelId, refusal); },
      markQuotaExhausted: (resetsAtMs) => build.availability.markQuotaExhausted(candidate, resetsAtMs),
      extraUsage: extraUsageOf(candidate.spendMode),
      // A login that the CLI no longer holds states nothing, so its reports confirm no included usage.
      reportsExtraUsage: () => cliLogin(launch.config.configDir)?.reportsExtraUsage === true,
      accountEmail: () => cliLogin(launch.config.configDir)?.email,
      onExtraUsageStop: (stop) => {
        build.notify({ type: "raise", occurrence: extraUsageNotice(stop, { providerId: candidate.providerId, instanceId: candidate.instanceId, configDir: launch.config.configDir, name: login?.label ?? login?.identity ?? CLAUDE_AGENT_SDK_LABEL }) });
      },
      recordUsage: (windows) => { readings.record({ configDir: launch.config.configDir, accountId: candidate.instanceId }, windows, Date.now()); },
      recordOutcome: (outcome) => { observationsOf(seams).recordRequest({ configDir: launch.config.configDir, accountId: candidate.instanceId }, outcome); },
      providerSessionKey: lifetime.providerSessionKey,
      ...(lifetime.demand === undefined ? {} : { demand: lifetime.demand }),
    };
    const ownEngine = () => Effect.runPromise(Scope.provide(lifetime.scope)(makeBridge(config)));
    let operations;
    if (sharedHost === undefined) operations = await ownEngine();
    else {
      const agent = createHostedAgent({
        registry: seams.agentHosts ?? processAgentHosts, launchHost: (seams.createHostLauncher ?? createHostLauncher)(launch.config), configDir: launch.config.configDir,
        tree: sharedHost, login: accessProviderAccountKey(candidate), projectRoot: build.projectRoot, wireModelId: build.wireModelId, contextLimit,
        lineup: build.accountOfferings, recordModelRefusal: build.recordModelRefusal, silentVersions: processSilentVersions,
        markQuotaExhausted: config.markQuotaExhausted, extraUsage: config.extraUsage, reportsExtraUsage: config.reportsExtraUsage, accountEmail: config.accountEmail, engineShell: config.engineShell,
        onExtraUsageStop: config.onExtraUsageStop, recordUsage: config.recordUsage, recordOutcome: config.recordOutcome, ownEngine,
        ...(lifetime.demand === undefined ? {} : { demand: lifetime.demand }),
        ...(seams.dispatcherStepDeadlineMs === undefined ? {} : { dispatcherStepDeadlineMs: seams.dispatcherStepDeadlineMs }),
      });
      hosted = agent;
      // The lifetime's close waits for the host that the agent's use kept open, so a session's disposal and a drain
      // return only after its engine stopped.
      Effect.runSync(Scope.addFinalizerExit(lifetime.scope, (exit) => Effect.promise(() => agent.close(Exit.hasInterrupts(exit) ? "abort" : "lifetime-end"))));
      operations = agent.operations;
    }
    return createAnthropicAdapter(Redacted.make(""), build.wireModelId, build.modelsClient, {
      accessProvider: CLAUDE_AGENT_SDK_PROVIDER_ID, catalogId: "anthropic", candidate,
      resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? null,
      operations, toolPresentation: bridgePresentation,
      ...(sharedHost === undefined ? {} : { hosted: true }),
    });
  });
}
