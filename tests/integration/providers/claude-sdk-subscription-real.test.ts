/**
 * Live qualification of the bundled Claude engine, the tier that every engine bump passes on macOS, Linux, and
 * Windows during release readiness, after the fake-host tier. It runs a few cheap Haiku requests
 * on the `LIVE_AUTH_PROFILE` auth profile through the production route: the provider plan, request
 * admission, and failover walk of a headless run choose the Claude login of the profile that serves each request, so a
 * login whose included usage is spent is passed or left as production passes or leaves it. Each request must reach
 * the Agent SDK client and the engine that ships with Flywheel on a login's included usage: the test refuses any other
 * route that the walk selects, such as paid use of a login or an API key, before that route sends anything, and paid
 * use stays off, so a request that extra usage would serve stops the login instead of spending money. Logins are
 * never changed; the run records what a headless run records, such as a login's spent quota.
 *
 * A host whose profile has no Claude login with included usage fails here, and the refusal names the command that
 * adds a login. Readiness reports a profile without a Claude login as a blocker before it starts the suite.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { liveClaudeAccounts } from "../../../scripts/claude-engine-release.js";
import { streamAssistantTurn } from "../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import type { AssistantTurnResult } from "../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import { estimateMessageTokens } from "../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import type { ConversationMessage, ServingAttempt, StreamOptions } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { resolveModelInteractionProfile } from "../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { createLauncherScope, createProcessSupervisor } from "../../../src/infra/process-supervisor.js";
import { composePortableModuleServices } from "../../../src/orchestration/app-service/module-service-host.js";
import { createRuntimeConfigOwner } from "../../../src/orchestration/config/runtime-config-owner.js";
import { installedModules } from "../../../src/orchestration/module-catalog.js";
import { createMcpConnectors } from "../../../src/orchestration/modules/mcp/connectors.js";
import { claudeLoginEngines } from "../../../src/orchestration/modules/mcp/service.js";
import { createClaudeAgentSdkModule } from "../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import type { ClaudeAgentSdkSeams } from "../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { CLAUDE_AGENT_SDK_LOGIN_COMMAND, CLAUDE_AGENT_SDK_MODULE_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, REFRESH_LOCK_BOUND_MS, refreshLockPath } from "../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { createQueryLauncher, type EngineLaunch } from "../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import type { StepAsk } from "../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { captureDiagnostics, ownInPlaceGate, removeEngineProbes, until } from "../orchestration/modules/provider-claude-agent-sdk/_claude-sdk-client.js";
import { LIVE_AUTH_PROFILE, liveDirectories, withLiveClient, type LiveRoute } from "./_live-client.js";

const MODEL = "claude-haiku-5-5";
const READ_TOOL = { name: "read", description: "Reads a text file of the project and returns its content.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const SYSTEM = { stable: "You are a terse assistant in a test. Follow each instruction exactly.", session: "", conversation: "" };

const temporary = temporaryDirectories();
const { payloads } = captureDiagnostics();
removeEngineProbes();

/** Why the attempt is not the bundled engine on a login's included usage, or undefined when it is. */
function refuseOtherRoutes(attempt: ServingAttempt): string | undefined {
  const candidate = attempt.accessProviderCandidate;
  if (candidate?.kind === "subscription" && candidate.providerId === CLAUDE_AGENT_SDK_PROVIDER_ID && candidate.spendMode === "included") return undefined;
  return `this tier runs only the bundled Claude engine on the included usage of a Claude login of the auth profile "${LIVE_AUTH_PROFILE}"; add a login with FLYWHEEL_AUTH_PROFILE=${LIVE_AUTH_PROFILE} ${CLAUDE_AGENT_SDK_LOGIN_COMMAND}`;
}

/** What one request answered. `history` is the conversation as a chat holds it after the request: the messages that
 *  the request sent, with the reminders that the route added to them, and the answer. */
interface Answer {
  readonly turn: AssistantTurnResult;
  readonly history: ConversationMessage[];
  readonly engineSessionId: unknown;
}

/** One conversation: each `stream` call is one model request, which keeps its engine between requests as a chat does. */
interface Conversation {
  stream(messages: ConversationMessage[], extra?: Partial<Pick<StreamOptions, "tools" | "systemPrompt" | "reasoningEffort">>): Promise<Answer>;
}

/** Runs `use` with conversations on the route that the production walk resolves in a scratch project, and checks
 *  afterwards that included usage served every request. The engines end only after a login's token refresh, if one
 *  runs, is saved. */
async function onLiveRoute(label: string, use: (open: () => Promise<Conversation>) => Promise<void>, seams: ClaudeAgentSdkSeams = {}): Promise<void> {
  const executionCwd = join(temporary("claude-sdk-live-"), "project");
  mkdirSync(executionCwd);
  const route: LiveRoute = {
    model: MODEL,
    refuse: refuseOtherRoutes,
    // The test preload installs a Claude module whose engine runs on a test account home, so no test reaches the
    // keychain of the person who runs it. This tier needs that keychain, where the profile's logins keep their tokens.
    modules: installedModules().map((module) => module.id === CLAUDE_AGENT_SDK_MODULE_ID ? createClaudeAgentSdkModule(seams) : module),
  };
  const lifetimes: Scope.Closeable[] = [];
  await withLiveClient(label, async ({ createClient }) => {
    const open = async (): Promise<Conversation> => {
      const scope = Effect.runSync(Scope.make());
      lifetimes.push(scope);
      const providerSessionKey = `qualification-${crypto.randomUUID()}`;
      const client = await createClient({ providerSessionKey, scope });
      return {
        stream: async (messages, extra = {}) => {
          const admitted = await client.admitRequest();
          let sent: readonly ConversationMessage[] = [];
          const turn = await streamAssistantTurn({
            client, executionCwd,
            // The prepared messages hold the reminders that the route added, which a chat keeps in its history.
            request: { run: (request) => admitted.run({ ...request, execute: (candidate) => { sent = candidate.prepared.messages; return request.execute(candidate); } }) },
            interactionProfile: resolveModelInteractionProfile(client.model, client.modelFamily),
            messages, tools: extra.tools ?? [READ_TOOL], systemPrompt: extra.systemPrompt ?? SYSTEM, reasoningEffort: extra.reasoningEffort,
            signal: undefined, cacheRetention: undefined, providerSessionKey, promptCacheKey: providerSessionKey, providerOptions: undefined,
            staleMasking: undefined, requestContext: undefined, requestAudit: undefined,
            turn: 0, messageCount: messages.length,
            estimatedContextTokens: messages.reduce((total, message) => total + estimateMessageTokens(message, 0), 0),
            onEvent: () => {},
          });
          const engineSessionId = payloads("provider.claude_sdk.query.started").findLast((payload) => payload["providerSessionKey"] === providerSessionKey)?.["sessionId"];
          expect(engineSessionId).toEqual(expect.any(String));
          return { turn, history: [...sent, { kind: "assistant", content: turn.assistantContent, ...turn.assistantMetadata }], engineSessionId };
        },
      };
    };
    try {
      await use(open);
    } finally {
      for (const lifetime of lifetimes) await Effect.runPromise(Scope.close(lifetime, Exit.void));
      const configDirs = liveClaudeAccounts(liveDirectories.userDataRoot, process.cwd(), LIVE_AUTH_PROFILE).map((login) => login.configDir);
      await until(() => configDirs.every((configDir) => !existsSync(refreshLockPath(configDir))), "the logins' token refresh", REFRESH_LOCK_BOUND_MS);
    }
  }, route);
  const billing = payloads("provider.claude_sdk.rate_limit").map((payload) => payload["billing"]);
  expect(billing).toContain("included");
  expect(billing.filter((served) => served !== "included" && served !== "refused")).toEqual([]);
}

const user = (content: string): ConversationMessage => ({ kind: "user", origin: "human", content });
const text = ({ turn }: Answer): string => turn.assistantContent.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
const answered = ({ turn }: Answer): void => { expect(turn.outcome).toMatchObject({ kind: "ok" }); };
/** The answer as the conversation stores it, so the next request replays it as this provider's own answer. */
function assistantMessage({ history }: Answer): Extract<ConversationMessage, { kind: "assistant" }> {
  const message = history.at(-1);
  if (message?.kind !== "assistant") throw new Error("the history ends without the answer");
  return message;
}

describe(`the bundled Claude engine on the ${LIVE_AUTH_PROFILE} profile`, () => {
  test("a chat request answers", async () => {
    await onLiveRoute("a chat request answers", async (open) => {
      const answer = await (await open()).stream([user("Reply with the single word: pong")]);
      answered(answer);
      expect(text(answer).toLowerCase()).toContain("pong");
    });
  }, 120_000);

  test("same-thread hooks admit a tool call and its continuation, and the model reads the result", async () => {
    const sameThreadEngines = new Set<string>();
    const steps: (StepAsk & { readonly sessionId: string })[] = [];
    const observed = <Launch extends EngineLaunch>(launch: Launch, sessionId: string): Launch => ({
      ...launch,
      stepGate: { ask: (step) => {
        const admitted = launch.stepGate.ask(step);
        if (admitted) steps.push({ ...step, sessionId });
        return admitted;
      } },
      onStderrLine: (line) => {
        if (line.includes("hooks module step-gate@inline loaded (same-thread,")) sameThreadEngines.add(sessionId);
        launch.onStderrLine(line);
      },
    });
    await onLiveRoute("a tool call reaches Flywheel", async (open) => {
      const chat = await open();
      const question = user("Use the read tool on note.txt, then reply with only the scratch word that it names.");
      const first = await chat.stream([question]);
      answered(first);
      const [call] = first.turn.toolCalls;
      // A copy, because Bun's `toMatchObject` writes its asymmetric matchers into the object it checks, and the call goes
      // into the next request.
      expect(structuredClone(call)).toMatchObject({ id: expect.any(String), name: "read", input: { path: expect.stringContaining("note.txt") } });
      const second = await chat.stream([...first.history, { kind: "toolResult", toolUseId: call?.id ?? "", content: [{ type: "text", text: "The scratch word is marigold." }] }]);
      answered(second);
      expect(text(second).toLowerCase()).toContain("marigold");
      expect(second.engineSessionId).toBe(first.engineSessionId);
      expect(payloads("provider.claude_sdk.query.started").filter((payload) => payload["sessionId"] === first.engineSessionId)).toHaveLength(1);
      expect([...sameThreadEngines]).toEqual(expect.arrayContaining([first.engineSessionId]));
      const admitted = steps.filter(({ sessionId }) => sessionId === first.engineSessionId);
      expect(admitted.map(({ index }) => index)).toEqual([0, 1]);
      expect(admitted[1]?.turnId).toBe(admitted[0]?.turnId);
    }, {
      createLauncher: (config) => {
        const launch = createQueryLauncher(config);
        return (input) => launch(observed(input, input.session.id));
      },
    });
  }, 120_000);

  test("an edited history rotates the engine in place after its version passes the self-test", async () => {
    await onLiveRoute("an edited history rotates the engine in place", async (open) => {
      const chat = await open();
      const first = await chat.stream([user("Reply with the single word: alpha")]);
      answered(first);
      // The first request starts the self-test of the engine's version, which must be listed and pass.
      await until(() => payloads("provider.claude_sdk.in_place.checked").length > 0, "the in-place self-test", 60_000);
      expect(payloads("provider.claude_sdk.in_place.checked")).toEqual([expect.objectContaining({ outcome: "passed" })]);
      const edited: ConversationMessage = { ...assistantMessage(first), content: [{ type: "text", text: "beta" }] };
      const second = await chat.stream([user("Reply with the single word: alpha"), edited, user("Which single word did you reply with? Reply with that word only.")]);
      answered(second);
      expect(text(second).toLowerCase()).toContain("beta");
      expect(second.engineSessionId).toBe(first.engineSessionId);
      expect(payloads("provider.claude_sdk.query.reloaded").filter((payload) => payload["sessionId"] === first.engineSessionId)).toEqual([expect.objectContaining({ trigger: "history", cut: true })]);
      expect(payloads("provider.claude_sdk.query.started").filter((payload) => payload["sessionId"] === first.engineSessionId)).toHaveLength(1);
    }, { inPlaceGate: ownInPlaceGate() });
  }, 180_000);

  test("an answer that holds only thinking resumes on a new engine", async () => {
    await onLiveRoute("an answer that holds only thinking resumes", async (open) => {
      const question = user("What is 17 multiplied by 23? Think it through, then reply with the number only.");
      const first = await (await open()).stream([question], { reasoningEffort: "high" });
      answered(first);
      // Keep only the model's signed thinking, as a turn that a person stopped after the model thought.
      const thinking = first.turn.assistantContent.filter((block) => block.type === "thinking");
      expect(thinking).toEqual([expect.objectContaining({ signature: expect.any(String) })]);
      const resumed = await (await open()).stream([question, { ...assistantMessage(first), content: thinking }, user("Now reply with that number only.")], { reasoningEffort: "high" });
      answered(resumed);
      expect(text(resumed)).toContain("391");
    });
  }, 180_000);

  test("a subagent's conversation runs beside its parent's, and a title request answers without tools", async () => {
    await onLiveRoute("a subagent's conversation runs beside its parent's", async (open) => {
      const [parent, child, titler] = await Promise.all([open(), open(), open()]);
      const [parentAnswer, childAnswer, title] = await Promise.all([
        parent.stream([user("Reply with the single word: parent")]),
        child.stream([user("Reply with the single word: child")]),
        titler.stream([user("Name this chat: a person asks how to bake sourdough bread at home.")], { tools: [], systemPrompt: { stable: "Reply with a title of three to six words for the chat. Reply with the title only.", session: "", conversation: "" } }),
      ]);
      for (const turn of [parentAnswer, childAnswer, title]) answered(turn);
      expect(text(parentAnswer).toLowerCase()).toContain("parent");
      expect(text(childAnswer).toLowerCase()).toContain("child");
      const words = text(title).trim().split(/\s+/u);
      expect(words.length).toBeGreaterThanOrEqual(2);
      expect(words.length).toBeLessThanOrEqual(10);
      const engines = new Set([parentAnswer, childAnswer, title].map((answer) => answer.engineSessionId));
      expect(engines.size).toBe(3);
      expect(payloads("provider.claude_sdk.query.started").filter((payload) => engines.has(payload["sessionId"]))).toHaveLength(3);
    });
  }, 180_000);

  test("reads the login's claude.ai connectors, reads each one's tools from the masked debug log, and calls a read-only tool", async () => {
    // The connectors run on the logins of the live profile, which the provider service resolves as a runtime does.
    const previousProfile = process.env["FLYWHEEL_AUTH_PROFILE"];
    process.env["FLYWHEEL_AUTH_PROFILE"] = LIVE_AUTH_PROFILE;
    const supervisor = createProcessSupervisor();
    const launcher = createLauncherScope(supervisor);
    const config = await createRuntimeConfigOwner({ userDataRoot: liveDirectories.userDataRoot, watch: false });
    // The test preload's Claude module runs on a test account home; the connectors need the person's keychain.
    const services = composePortableModuleServices([createClaudeAgentSdkModule()], () => [CLAUDE_AGENT_SDK_MODULE_ID], { directories: liveDirectories, config, launcher, onSelectionChanged: () => () => {} });
    services.start();
    const connectors = createMcpConnectors(async () => await services.services.get(claudeLoginEngines)?.logins() ?? []);
    try {
      const listed = Object.keys((await connectors.read()).connectors);
      if (listed.length === 0) throw new Error(`this test needs a claude.ai connector on a Claude login of the auth profile "${LIVE_AUTH_PROFILE}"; add one at claude.ai`);
      const tools = [];
      for (const name of listed) {
        // A connection exists only when the capture found every credential header masked and every schema whole.
        const connection = await connectors.connect(name, AbortSignal.timeout(60_000));
        expect(connection.tools().length).toBeGreaterThan(0);
        for (const tool of connection.tools()) {
          expect(tool.inputSchema).toMatchObject({ type: "object" });
          tools.push({ connection, tool });
        }
      }
      const needsArguments = (schema: unknown): boolean => typeof schema === "object" && schema !== null && "required" in schema && Array.isArray(schema.required) && schema.required.length > 0;
      // A connector can answer a call with no arguments as an error, which the engine reports like a lost call; the
      // Claude Docs connector's guide answers it.
      const callable = tools.filter(({ tool }) => tool.annotations?.readOnlyHint === true && !needsArguments(tool.inputSchema));
      const readOnly = callable.find(({ tool }) => tool.name === "guide") ?? callable[0];
      if (readOnly === undefined) throw new Error("no connector of the login has a read-only tool without required arguments");
      const result = await readOnly.connection.callTool({ name: readOnly.tool.name, arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      await connectors.stop();
      await services.dispose();
      await config.dispose();
      await launcher.close();
      await supervisor.dispose();
      if (previousProfile === undefined) delete process.env["FLYWHEEL_AUTH_PROFILE"];
      else process.env["FLYWHEEL_AUTH_PROFILE"] = previousProfile;
    }
  }, 180_000);
});
