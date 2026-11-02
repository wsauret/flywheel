/**
 * The Agent SDK provider client of one Claude login, as the qualification tiers drive it: the production client
 * factory, the bridge, and the engine that ships with Flywheel, on a real process supervisor. Only the candidate
 * that the provider walk would pick is fixed here, so a test reaches the engine without a route plan or an auth
 * profile store, and writes no Flywheel state into the login's profile.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { DebugLog, type DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import type { ModelCost, ModelPricing } from "../../../../../src/infra/llm/models.js";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../../src/infra/process-supervisor.js";
import { privateTemporaryRoot } from "../../../../../src/infra/private-temporary-root.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { handleStreamEvent, type AssistantTurnResult } from "../../../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import type { Claim, ContentBlock, ConversationMessage, ProviderStreamEvent, StagedProviderClient, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { engineModelId } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import { createClaudeAgentSdkClient } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/client.js";
import { holdSharedTree, type SharedTree } from "../../../../../src/orchestration/agent-runtime/shared-tree.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { inPlaceGate, runInPlaceSelfTest } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/in-place-check.js";
import type { ClaudeAgentSdkSeams } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { fakeAvailability } from "../../../../unit/orchestration/agent-runtime/llm/_provider-chain-harness.js";
import { FAKE_ACCOUNT, startFakeHost, writeFakeClaudeLogin, type FakeHost, type FakeReply, type RecordedRequest } from "./_fake-host.js";

/** What one client runs on. */
export interface SdkClientTarget {
  /** The login's absolute `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string;
  /** The account id that the login names, which the candidate carries. */
  readonly accountId: string;
  readonly wireModelId: string;
  readonly contextLimit: number;
  readonly projectRoot: string;
  /** `included` refuses Claude extra usage, as every account does until the person allows paid use. */
  readonly spendMode?: "included" | "automatic";
  readonly seams?: ClaudeAgentSdkSeams;
  /** What the provider walk gives the build in place of the defaults: the account's lineup (`CLAUDE_LINEUP`), its
   *  availability, and the recorder of its refusals. */
  readonly build?: AccountBuild;
}

/** The parts of a build that come from the login's account. */
export type AccountBuild = Partial<Pick<AccessProviderBuild, "accountOfferings" | "availability" | "recordModelRefusal" | "notify">>;

/** The models of a Claude login's lineup, each with the facts that models.dev states for it. */
export const CLAUDE_LINEUP = [
  { wireModelId: "claude-haiku-5-5", releaseDate: "2026-09-10" },
  { wireModelId: "claude-sonnet-5-5", releaseDate: "2026-09-10" },
  { wireModelId: "claude-opus-5-5", releaseDate: "2026-09-10" },
  { wireModelId: "claude-fable-5-1", releaseDate: "2026-06-04" },
].map(({ wireModelId, releaseDate }) => ({ wireModelId, resolvedModelMetadata: providerModelInfo({ provider: "anthropic", id: wireModelId, releaseDate, contextLimit: 200_000, outputLimit: 128_000, reasoning: true }) }));

/** A connected client. Each `stream` call is one model request of one conversation, which keeps its engine between
 *  requests as a chat does. `onEvent` sees each event as it arrives, so a test can interrupt the request mid-stream. */
export interface SdkConversation {
  stream(options: StreamOptions, onEvent?: (event: ProviderStreamEvent) => void): Promise<StreamResult>;
  /** Anticipates a request of `options`, as a session's owner does while a client shows the session. */
  anticipate(options: StreamOptions): Promise<Claim | undefined>;
}

/** A client that the provider factory built and nothing connected yet, as a route plan holds it. */
export interface StagedSdkClient {
  readonly staged: StagedProviderClient;
  connect(): Promise<SdkConversation>;
  /** Ends the conversation's lifetime as the runner does when a person's or a parent's stop ends the run: with an
   *  interruption. */
  stop(): Promise<void>;
  /** Ends the conversation's lifetime as the runner does when it replaces the client with one of another route, such
   *  as after a model change (`ProviderRuntimeCache`): with no interruption. */
  replace(): Promise<void>;
}

/** How a test opens one more conversation. Every conversation has its own lifetime, as a runner gives each client. */
export interface ConversationOptions {
  /** The chat tree whose shared agent host serves the conversation, as for a workflow agent or a subagent. */
  readonly sharedHost?: string;
  /** The conversation's own model and context limit, in place of the target's. */
  readonly model?: { readonly wireModelId: string; readonly contextLimit: number };
}

/** What one request streamed, or the error that ended it. */
export interface StreamResult {
  readonly events: readonly ProviderStreamEvent[];
  readonly error: Error | undefined;
}

/** Rate cards in USD per million tokens, a different one for each model, so a test can tell which model priced an
 *  answer. Every other model has no rate card. */
const rateCards = new Map<string, ModelCost>([["claude-haiku-5-5", { input: 1, output: 5 }], ["claude-opus-5-5", { input: 5, output: 25 }]]);
const pricingOf = (model: string): ModelPricing | undefined => {
  const rateCard = rateCards.get(model);
  return rateCard === undefined ? undefined : { status: "available", rateCard, provenance: { source: "provider-docs", provider: "anthropic", model } };
};

function sdkBuild(target: SdkClientTarget, launcher: AccessProviderBuild["launcher"], lifetime: Scope.Scope, sharedHost?: string): AccessProviderBuild {
  const candidate = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: target.accountId, spendMode: target.spendMode ?? "included" } as const;
  const credential = { type: "external", configDir: target.configDir } as const;
  const pricing = pricingOf(target.wireModelId);
  const metadata = providerModelInfo({ provider: "anthropic", id: target.wireModelId, contextLimit: target.contextLimit, outputLimit: 64_000, reasoning: true, ...(pricing === undefined ? {} : { pricing }) });
  return {
    notify: target.build?.notify ?? (() => {}),
    candidate, providerIdentity: { name: "Anthropic Sub", credential: "oauth" },
    model: metadata.id, wireModelId: metadata.id, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "qualification", authDir: target.configDir, oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([[candidate.providerId, [{ instanceId: candidate.instanceId, identity: candidate.instanceId, lineageId: candidate.instanceId, credential }]]]),
    },
    classifySlot: () => "subscription", availability: target.build?.availability ?? fakeAvailability({}).availability, projectRoot: target.projectRoot,
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: target.build?.recordModelRefusal ?? (() => {}),
    accountOfferings: target.build?.accountOfferings ?? (() => CLAUDE_LINEUP.map((offering) => ({ ...offering, candidate, dataUse: "standard" as const }))),
    launcher,
    providerSessionLifetime: {
      providerSessionKey: `qualification-${crypto.randomUUID()}`, scope: lifetime, ...(sharedHost === undefined ? {} : { sharedHost: heldTree(lifetime, sharedHost) }),
    },
  };
}

/** The shared state of the chat tree `treeRootSessionId`, held while `lifetime` lives, as a runner holds it. */
function heldTree(lifetime: Scope.Scope, treeRootSessionId: string): SharedTree {
  const { tree, release } = holdSharedTree(treeRootSessionId, () => composeFirstPartyModules());
  Effect.runSync(Scope.addFinalizer(lifetime, Effect.sync(release)));
  return tree;
}

async function drain(stream: AsyncIterable<ProviderStreamEvent>, onEvent: ((event: ProviderStreamEvent) => void) | undefined): Promise<StreamResult> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of stream) {
      events.push(event);
      onEvent?.(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/** Runs `use` with conversations on the login of `target`, then closes every conversation's engine, the launch
 *  scope, and the supervisor, whatever `use` did. `open` connects one more conversation on the same login, as a
 *  subagent's session does, and `stage` builds one without connecting it. */
export async function withSdkClient<T>(
  target: SdkClientTarget,
  use: (open: (options?: ConversationOptions) => Promise<SdkConversation>, stage: (options?: ConversationOptions) => Promise<StagedSdkClient>) => Promise<T>,
): Promise<T> {
  const supervisor = createProcessSupervisor();
  const launcher = createLauncherScope(supervisor);
  const lifetimes: Scope.Closeable[] = [];
  const stage = async (options: ConversationOptions = {}): Promise<StagedSdkClient> => {
    const lifetime = Effect.runSync(Scope.make());
    lifetimes.push(lifetime);
    const staged = await createClaudeAgentSdkClient(sdkBuild({ ...target, ...options.model }, launcher, lifetime, options.sharedHost), target.seams);
    return {
      staged,
      connect: async () => {
        const client = await staged.connect();
        return {
          stream: (streamOptions, onEvent) => drain(client.streamWithTools(streamOptions), onEvent),
          anticipate: async (streamOptions) => await client.anticipate?.(streamOptions),
        };
      },
      stop: async () => { await Effect.runPromise(Scope.close(lifetime, Exit.interrupt())); },
      replace: async () => { await Effect.runPromise(Scope.close(lifetime, Exit.void)); },
    };
  };
  const open = async (options?: ConversationOptions): Promise<SdkConversation> => (await stage(options)).connect();
  try {
    return await use(open, stage);
  } finally {
    for (const lifetime of lifetimes) await Effect.runPromise(Scope.close(lifetime, Exit.void));
    await launcher.close();
    await supervisor.dispose();
  }
}

/** The text that a request streamed. */
export function streamedText(result: StreamResult): string {
  return result.events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("");
}

/** The tool calls that a request streamed, by Flywheel name. */
export function streamedToolCalls(result: StreamResult): ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: unknown }> {
  return result.events.flatMap((event) => event.kind === "tool_use" ? [{ id: event.toolCall.id, name: event.toolCall.name, input: event.toolCall.input }] : []);
}

/** The assistant message that the agent loop stores for a request: the streamed events folded by the loop's own fold
 *  (`handleStreamEvent`), with the serving metadata that the loop stamps on the turn, so the next request replays it as
 *  this provider's own answer. A request that ended without its `done` event carries no metadata, as a partial answer
 *  that the loop commits after an interrupt does. */
export function assistantMessage(result: StreamResult): Extract<ConversationMessage, { kind: "assistant" }> & { readonly content: ContentBlock[] } {
  const turn: AssistantTurnResult = {
    outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [], assistantMetadata: undefined, lastAssistantMetadata: undefined,
    usageAnchor: undefined, terminalEvent: undefined, transportContext: undefined,
  };
  for (const event of result.events) handleStreamEvent(event, turn);
  return { kind: "assistant", content: turn.assistantContent, accessProvider: "claude_agent_sdk", ...turn.assistantMetadata };
}

/** The diagnostic records of each test, in order. `payloads` reads one record family. */
export interface CapturedDiagnostics {
  readonly records: DebugLogRecordInput[];
  payloads(type: string): ReadonlyArray<{ readonly [field: string]: unknown }>;
}

/** Captures every diagnostic record of each test. A test file calls it once at its top level. */
export function captureDiagnostics(): CapturedDiagnostics {
  const records: DebugLogRecordInput[] = [];
  beforeEach(async () => {
    records.length = 0;
    await DebugLog.forward((record) => { records.push(record); });
    DebugLog.setVerbose(true);
  });
  afterEach(async () => {
    DebugLog.setVerbose(false);
    await DebugLog.close();
  });
  return {
    records,
    payloads: (type) => records.flatMap(({ type: recorded, payload }) => recorded === type && typeof payload === "object" && payload !== null ? [Object.fromEntries(Object.entries(payload))] : []),
  };
}

/**
 * The production in-place gate, with a memory of its own. The process-wide gate decides each engine version once and
 * records that decision once, possibly during an earlier test, so a test that asserts the decision gives its client
 * this gate. It runs the same allowlist and the same self-test.
 */
export function ownInPlaceGate(): NonNullable<ClaudeAgentSdkSeams["inPlaceGate"]> {
  const checks = new Map();
  return (config) => inPlaceGate((cliVersion) => runInPlaceSelfTest(config, cliVersion), engineModelId(config.wireModelId, config.contextLimit), checks);
}

/** Resolves once `condition` holds, polling every 20 ms, or throws after `timeoutMs`. */
export async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/**
 * Removes what engines of this file leave in Flywheel's engine temporary root. The in-place self-test starts its
 * engine there whatever the test's environment names, and that engine makes its own `claude-<uid>` directory and
 * leaves a `fswatch-probe-*` directory in it when Flywheel ends it. Only entries that appeared while the file ran are
 * removed, so a Flywheel that runs beside the tests keeps its own. A test file calls it once at its top level.
 */
export function removeEngineProbes(): void {
  const root = () => privateTemporaryRoot(tmpdir(), "fw-claude");
  const entries = () => readdirSync(root(), { withFileTypes: true }).flatMap((entry) => {
    const path = join(root(), entry.name);
    if (!entry.isDirectory()) return [path];
    try {
      return [path, ...readdirSync(path).map((name) => join(path, name))];
    } catch {
      return [path]; // Another engine removed it meanwhile.
    }
  });
  let before = new Set<string>();
  beforeAll(() => { before = new Set(entries()); });
  afterAll(() => {
    for (const entry of entries()) if (!before.has(entry)) rmSync(entry, { recursive: true, force: true });
  });
}

/** What a fake-host case runs on. */
export interface FakeHostRun {
  readonly host: FakeHost;
  readonly open: (options?: ConversationOptions) => Promise<SdkConversation>;
  readonly stage: (options?: ConversationOptions) => Promise<StagedSdkClient>;
  readonly configDir: string;
  readonly projectRoot: string;
  readonly seams: ClaudeAgentSdkSeams;
}

export interface FakeHostOptions {
  readonly model?: string;
  readonly contextLimit?: number;
  readonly seams?: ClaudeAgentSdkSeams;
  readonly build?: AccountBuild;
  /** More engine variables, beside the ones that send the engine to the fake host. */
  readonly environment?: { readonly [name: string]: string };
}

/**
 * Runs `use` with conversations of the placeholder login against a fake host that answers with `reply`, in
 * directories that `temporary` makes and its test removes. After `use`, it asserts that the engine reached only the
 * fake host: the one other connection that the engine tries is the API host, which the trap refused.
 */
export async function onFakeHost(temporary: (prefix: string) => string, reply: (request: RecordedRequest, index: number) => FakeReply, use: (run: FakeHostRun) => Promise<void>, options: FakeHostOptions = {}): Promise<void> {
  // The physical path, as the engine resolves its working directory, so its own environment section and a
  // reminder's directory name the same path where the temporary root is a symbolic link (macOS).
  const root = realpathSync(temporary("claude-engine-"));
  const home = join(root, "home");
  const configDir = join(root, "login");
  const projectRoot = join(root, "project");
  const engineTemporary = join(root, "engine-tmp");
  for (const dir of [home, projectRoot, engineTemporary]) mkdirSync(dir);
  writeFakeClaudeLogin(configDir);
  const host = startFakeHost(reply);
  // The engine leaves probe files in its temporary directory, so each case gives it one that the case removes.
  const seams: ClaudeAgentSdkSeams = { cliEnvironment: { ...options.environment, ...host.environment, CLAUDE_CODE_TMPDIR: engineTemporary }, account: () => ({ home, user: "qualification" }), ...options.seams };
  try {
    await withSdkClient({
      configDir, accountId: FAKE_ACCOUNT.accountUuid, projectRoot, seams, ...(options.build === undefined ? {} : { build: options.build }),
      wireModelId: options.model ?? "claude-haiku-5-5", contextLimit: options.contextLimit ?? 200_000,
    }, (open, stage) => use({ host, open, stage, configDir, projectRoot, seams }));
    expect(host.trapped.filter((target) => target !== "CONNECT api.anthropic.com:443")).toEqual([]);
  } finally {
    await host.stop();
  }
}
