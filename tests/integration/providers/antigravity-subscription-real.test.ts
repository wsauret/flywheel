/**
 * Live qualification of the bundled Antigravity CLI, the tier that every agy bump passes on macOS, Linux, and Windows
 * during release readiness, after the fake-host tier. It runs a few short Gemini 3.8 Flash requests at the low
 * thinking level on the `LIVE_AUTH_PROFILE` auth profile through the production route: the provider plan, request
 * admission, and failover walk of a headless run choose the Google Antigravity login that serves each request. Each
 * request must reach the pinned `agy acp` engine on the login's included plan: the test refuses any other route that
 * the walk selects before that route sends anything. The module's process service runs here as it runs in a headless
 * process, so every engine runs on the login's private home and token store (on macOS its private keychain); the
 * test reads no token. Logins are never changed; the reconnect case signs the same account in again in its own place,
 * which agy answers from its stored token without a browser.
 *
 * The tool-call case also re-qualifies the field numbers of agy's conversation database that the route reads usage
 * from (`usage/conversation-usage.ts`): every request of a task must report complete usage, with cached reads on a
 * later one. A bump of agy that moves those fields fails it.
 *
 * A host whose profile has no Google Antigravity login fails here, and the refusal names the command that adds one.
 * Readiness reports a profile without one as a blocker before it starts the tier.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { DebugLog, type DebugLogRecordInput } from "../../../src/infra/debug-log.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../src/infra/process-supervisor.js";
import { streamAssistantTurn } from "../../../src/orchestration/agent-runtime/loop/turn/assistant-turn-stream.js";
import type { AssistantTurnResult } from "../../../src/orchestration/agent-runtime/loop/turn/assistant-turn-result.js";
import { estimateMessageTokens } from "../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import type { ConversationMessage, ProviderSessionLifetime, ProviderStreamEvent, ServingAttempt, StreamOptions } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { resolveModelInteractionProfile } from "../../../src/orchestration/agent-runtime/request/prompt/model-interaction-profile.js";
import { composePortableModuleServices } from "../../../src/orchestration/app-service/module-service-host.js";
import { createRuntimeConfigOwner } from "../../../src/orchestration/config/runtime-config-owner.js";
import { antigravityAccounts } from "../../../src/orchestration/modules/provider-google-antigravity/login/login.js";
import { googleAntigravityModule } from "../../../src/orchestration/modules/provider-google-antigravity/module.js";
import { GOOGLE_ANTIGRAVITY_LOGIN_COMMAND, GOOGLE_ANTIGRAVITY_MODULE_ID, GOOGLE_ANTIGRAVITY_PROVIDER_ID } from "../../../src/orchestration/modules/provider-google-antigravity/names.js";
import { AuthProfileManager } from "../../../src/orchestration/auth/auth-profile-manager.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { LIVE_AUTH_PROFILE, liveDirectories, withLiveClient } from "./_live-client.js";

const MODEL = "gemini-3.8-flash";
const ECHO_TOOL = { name: "echo", description: "Returns the text it is given.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const SYSTEM = { stable: "You are a terse assistant in a test. Follow each instruction exactly.", session: "", conversation: "" };
/** A stable system text long enough for Gemini's implicit prompt cache, which skips a short prompt. */
const LONG_SYSTEM = { ...SYSTEM, stable: [SYSTEM.stable, ...Array.from({ length: 120 }, (_, index) => `Reference rule ${String(index + 1)}: answer with the exact word that the person asks for, in lower case, with no punctuation and no other text.`)].join("\n") };

const temporary = temporaryDirectories();

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
const payloads = (type: string) => records.flatMap(({ type: recorded, payload }) => recorded === type && typeof payload === "object" && payload !== null ? [Object.fromEntries(Object.entries(payload))] : []);

/** The serving attempts of the current test, and why one that is not the included plan of a login is refused. */
const served: ServingAttempt[] = [];
function refuseOtherRoutes(attempt: ServingAttempt): string | undefined {
  served.push(attempt);
  const candidate = attempt.accessProviderCandidate;
  if (candidate?.kind === "subscription" && candidate.providerId === GOOGLE_ANTIGRAVITY_PROVIDER_ID && candidate.spendMode === "included") return undefined;
  return `this tier runs only the bundled Antigravity CLI on the included plan of a Google Antigravity login of the auth profile "${LIVE_AUTH_PROFILE}"; add a login with FLYWHEEL_AUTH_PROFILE=${LIVE_AUTH_PROFILE} ${GOOGLE_ANTIGRAVITY_LOGIN_COMMAND}`;
}

/** What one request answered. `history` is the conversation as a chat holds it after the request. */
interface Answer {
  readonly turn: AssistantTurnResult;
  readonly history: ConversationMessage[];
}

/** One conversation: each `stream` call is one model request, which keeps its engine session between requests. */
interface Conversation {
  readonly sessionKey: string;
  stream(messages: ConversationMessage[], extra?: Partial<Pick<StreamOptions, "tools" | "reasoningEffort" | "signal" | "systemPrompt">> & { readonly onEvent?: (event: ProviderStreamEvent) => void }): Promise<Answer>;
}

/** Runs `use` with the module's process service started on its own launcher, as a headless process starts it. */
async function withModuleService<T>(use: () => Promise<T>): Promise<T> {
  const previousProfile = process.env["FLYWHEEL_AUTH_PROFILE"];
  process.env["FLYWHEEL_AUTH_PROFILE"] = LIVE_AUTH_PROFILE;
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
  const launcher = createLauncherScope(supervisor);
  const config = await createRuntimeConfigOwner({ userDataRoot: liveDirectories.userDataRoot, watch: false });
  const services = composePortableModuleServices([googleAntigravityModule], () => [GOOGLE_ANTIGRAVITY_MODULE_ID], { directories: liveDirectories, config, launcher, onSelectionChanged: () => () => {} });
  services.start();
  try {
    return await use();
  } finally {
    await services.dispose();
    await config.dispose();
    await launcher.close();
    await supervisor.dispose();
    if (previousProfile === undefined) delete process.env["FLYWHEEL_AUTH_PROFILE"];
    else process.env["FLYWHEEL_AUTH_PROFILE"] = previousProfile;
  }
}

/** Runs `use` with conversations on the route that the production walk resolves, and checks afterwards that the
 *  included plan of a Google Antigravity login served every request. `open(tree)` opens a conversation of the chat
 *  tree rooted at `tree`, or of a tree of its own. */
async function onLiveRoute(label: string, use: (open: (tree?: string) => Promise<Conversation>) => Promise<void>): Promise<void> {
  served.length = 0;
  const executionCwd = join(temporary("antigravity-live-"), "project");
  mkdirSync(executionCwd);
  const lifetimes: Scope.Closeable[] = [];
  await withModuleService(() => withLiveClient(label, async ({ createClient }) => {
    const open = async (tree?: string): Promise<Conversation> => {
      const scope = Effect.runSync(Scope.make());
      lifetimes.push(scope);
      const sessionKey = `qualification-${crypto.randomUUID()}`;
      const lifetime: ProviderSessionLifetime = { providerSessionKey: sessionKey, scope, ...tree === undefined ? {} : { treeRootSessionId: tree } };
      const client = await createClient(lifetime);
      return {
        sessionKey,
        stream: async (messages, extra = {}) => {
          const admitted = await client.admitRequest();
          let sent: readonly ConversationMessage[] = [];
          const turn = await streamAssistantTurn({
            client, executionCwd,
            request: { run: (request) => admitted.run({ ...request, execute: (candidate) => { sent = candidate.prepared.messages; return request.execute(candidate); } }) },
            interactionProfile: resolveModelInteractionProfile(client.model, client.modelFamily),
            messages, tools: extra.tools ?? [ECHO_TOOL], systemPrompt: extra.systemPrompt ?? SYSTEM, reasoningEffort: extra.reasoningEffort ?? "low",
            signal: extra.signal, cacheRetention: undefined, providerSessionKey: sessionKey, promptCacheKey: sessionKey, providerOptions: undefined,
            staleMasking: undefined, requestAudit: undefined,
            turn: 0, messageCount: messages.length,
            estimatedContextTokens: messages.reduce((total, message) => total + estimateMessageTokens(message, 0), 0),
            onEvent: extra.onEvent ?? (() => {}),
          });
          return { turn, history: [...sent, { kind: "assistant", content: turn.assistantContent, ...turn.assistantMetadata }] };
        },
      };
    };
    try {
      await use(open);
    } finally {
      for (const lifetime of lifetimes) await Effect.runPromise(Scope.close(lifetime, Exit.void));
    }
  }, { model: MODEL, refuse: refuseOtherRoutes }));
  expect(served.length).toBeGreaterThan(0);
  expect(served.map((attempt) => attempt.accessProviderCandidate)).toEqual(served.map(() => expect.objectContaining({ kind: "subscription", providerId: GOOGLE_ANTIGRAVITY_PROVIDER_ID, spendMode: "included" })));
}

const user = (content: string): ConversationMessage => ({ kind: "user", origin: "human", content });
const text = ({ turn }: Answer): string => turn.assistantContent.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
const answered = ({ turn }: Answer): void => { expect(turn.outcome).toMatchObject({ kind: "ok" }); };
function assistantMessage({ history }: Answer): Extract<ConversationMessage, { kind: "assistant" }> {
  const message = history.at(-1);
  if (message?.kind !== "assistant") throw new Error("the history ends without the answer");
  return message;
}
/** The engine sessions that the test's conversations opened, each with the process that holds it and why it opened. */
const rotations = () => payloads("provider.antigravity.session.rotated").map((payload) => ({ processId: payload["processId"], sessionId: payload["sessionId"], reason: payload["reason"] }));

describe(`the bundled Antigravity CLI on the ${LIVE_AUTH_PROFILE} profile`, () => {
  test("a chat request answers on the login's included plan, with usage that includes cached reads on the next request", async () => {
    await onLiveRoute("a chat request answers", async (open) => {
      const chat = await open();
      const first = await chat.stream([user("Reply with the single word: pong")], { systemPrompt: LONG_SYSTEM });
      answered(first);
      expect(text(first).toLowerCase()).toContain("pong");
      const second = await chat.stream([...first.history, user("Reply with the single word: ping")], { systemPrompt: LONG_SYSTEM });
      answered(second);
      expect(text(second).toLowerCase()).toContain("ping");
      expect(second.turn.usageAnchor?.inputTokens).toBeGreaterThan(0);
      expect(second.turn.usageAnchor?.cacheReadTokens).toBeGreaterThan(0);
      // The second request is the next prompt of the same engine session.
      expect(rotations()).toHaveLength(1);
    });
  }, 180_000);

  test("three tool calls of one task each reach Flywheel, the model reads every result, and every request reports complete usage", async () => {
    await onLiveRoute("three tool calls reach Flywheel", async (open) => {
      const chat = await open();
      let history: ConversationMessage[] = [user("Call the echo tool three times, one call at a time and in this order, with the texts red, green, and blue. After the third result, reply with only the three results joined by commas.")];
      const calls: string[] = [];
      const usage: Extract<ProviderStreamEvent, { kind: "usage" }>[][] = [];
      const stream = (messages: ConversationMessage[]) => {
        const reported: Extract<ProviderStreamEvent, { kind: "usage" }>[] = [];
        usage.push(reported);
        return chat.stream(messages, { systemPrompt: LONG_SYSTEM, onEvent: (event) => { if (event.kind === "usage") reported.push(event); } });
      };
      for (let request = 0; request < 3; request += 1) {
        const answer = await stream(history);
        answered(answer);
        const [call] = answer.turn.toolCalls;
        expect(structuredClone(call)).toMatchObject({ id: expect.any(String), name: "echo", input: { text: expect.any(String) } });
        const echoed = String(call?.input["text"]);
        calls.push(echoed);
        history = [...answer.history, { kind: "toolResult", toolUseId: call?.id ?? "", content: [{ type: "text", text: `${echoed.toUpperCase()}-OK` }] }];
      }
      expect(calls.map((value) => value.toLowerCase())).toEqual(["red", "green", "blue"]);
      const final = await stream(history);
      answered(final);
      expect(final.turn.toolCalls).toEqual([]);
      for (const word of ["RED-OK", "GREEN-OK", "BLUE-OK"]) expect(text(final)).toContain(word);
      expect(rotations()).toHaveLength(1);
      // Each request ran its own model request, whose row states its complete usage; the cache serves the later ones.
      expect(usage.map((reported) => reported.map((event) => event.final))).toEqual([[true], [true], [true], [true]]);
      for (const [event] of usage) {
        expect(event?.inputTokens).toBeGreaterThan(0);
        expect(event?.outputTokens).toBeGreaterThan(0);
      }
      expect(usage.slice(1).some(([event]) => (event?.cacheReadTokens ?? 0) > 0)).toBe(true);
    });
  }, 240_000);

  test("an edited history opens a new engine session from Flywheel's history, and a change of thinking level keeps the session", async () => {
    await onLiveRoute("an edited history rotates the session", async (open) => {
      const chat = await open();
      const first = await chat.stream([user("Reply with the single word: alpha")]);
      answered(first);
      const edited: ConversationMessage = { ...assistantMessage(first), content: [{ type: "text", text: "beta" }] };
      const second = await chat.stream([user("Reply with the single word: alpha"), edited, user("Which single word did you reply with? Reply with that word only.")]);
      answered(second);
      expect(text(second).toLowerCase()).toContain("beta");
      expect(rotations()).toHaveLength(2);
      const third = await chat.stream([...second.history, user("Reply with the single word: gamma")], { reasoningEffort: "medium" });
      answered(third);
      expect(text(third).toLowerCase()).toContain("gamma");
      expect(rotations()).toHaveLength(2);
      const [opened, rotated] = rotations();
      expect(rotated?.processId).toBe(opened?.processId);
      expect(rotated?.sessionId).not.toBe(opened?.sessionId);
      // The engine acknowledged the new thought level on the established session, before the third prompt.
      expect(payloads("provider.antigravity.session.configured").filter((change) => change["configId"] === "thought_level" && change["sessionId"] === rotated?.sessionId))
        .toContainEqual(expect.objectContaining({ from: "low", to: "medium" }));
    });
  }, 240_000);

  test("a subagent of the same chat tree runs as another session of its parent's engine process", async () => {
    await onLiveRoute("a subagent shares its parent's engine", async (open) => {
      const parent = await open();
      const child = await open(parent.sessionKey);
      const parentAnswer = await parent.stream([user("Reply with the single word: parent")]);
      const childAnswer = await child.stream([user("Reply with the single word: child")]);
      for (const answer of [parentAnswer, childAnswer]) answered(answer);
      expect(text(parentAnswer).toLowerCase()).toContain("parent");
      expect(text(childAnswer).toLowerCase()).toContain("child");
      const sessions = rotations();
      expect(sessions).toHaveLength(2);
      expect(sessions[1]?.processId).toBe(sessions[0]?.processId);
      expect(sessions[1]?.sessionId).not.toBe(sessions[0]?.sessionId);
    });
  }, 180_000);

  test("a cancelled request ends its prompt, and the next request answers in a new engine session", async () => {
    await onLiveRoute("a cancelled request ends its prompt", async (open) => {
      const chat = await open();
      const question = user("Write every whole number from 1 to 3000 in words, one per line. Do not stop early.");
      // The test cancels at the first text of the answer, so the prompt is mid-turn at the engine.
      const abort = new AbortController();
      const reason = new Error("the test cancels the request");
      const cancelAtFirstText = (event: ProviderStreamEvent) => { if (event.kind === "text_delta" && !abort.signal.aborted) abort.abort(reason); };
      let cancelled: unknown;
      try {
        cancelled = (await chat.stream([question], { signal: abort.signal, onEvent: cancelAtFirstText })).turn.outcome;
      } catch (error) {
        cancelled = error;
      }
      expect(abort.signal.aborted).toBe(true);
      // The walk ends an aborted request with the abort reason, or settles it as aborted.
      if (cancelled instanceof Error) expect(cancelled.message).toBe(reason.message);
      else expect(cancelled).toEqual({ kind: "aborted" });
      const next = await chat.stream([question, { kind: "assistant", content: [{ type: "text", text: "one" }] }, user("Stop counting. Reply with the single word: after")]);
      answered(next);
      expect(text(next).toLowerCase()).toContain("after");
      const sessions = rotations();
      expect(sessions).toHaveLength(2);
      expect(sessions[1]?.processId).toBe(sessions[0]?.processId);
      expect(payloads("provider.antigravity.process.ended").filter((ended) => ended["processId"] === sessions[0]?.processId)).toEqual([]);
      // The cancelled prompt itself (the one after its session's primer, which the rotation record follows) ended at the
      // engine as a turn end or a cancel before the next request opened its session.
      const order = records.flatMap(({ type, payload }) => type.startsWith("provider.antigravity.") && typeof payload === "object" && payload !== null ? [Object.fromEntries([["type", type], ...Object.entries(payload)])] : []);
      const at = (type: string, sessionId: unknown) => order.findIndex((record) => record.type === type && record["sessionId"] === sessionId);
      const cancelledEnd = order.findLastIndex((record) => record.type === "provider.antigravity.prompt.ended" && record["sessionId"] === sessions[0]?.sessionId);
      expect(cancelledEnd).toBeGreaterThan(at("provider.antigravity.session.rotated", sessions[0]?.sessionId));
      expect(cancelledEnd).toBeLessThan(at("provider.antigravity.session.rotated", sessions[1]?.sessionId));
      expect(["end_turn", "cancelled"]).toContain(order[cancelledEnd]?.["stopReason"]);
    });
  }, 180_000);

  test("a login again of the same account keeps its place, answered from agy's stored token without a browser", async () => {
    const authDir = new AuthProfileManager({ userDataRoot: liveDirectories.userDataRoot, projectRoot: process.cwd(), env: { FLYWHEEL_AUTH_PROFILE: LIVE_AUTH_PROFILE } }).inspect().directory;
    const before = antigravityAccounts(authDir);
    const [account] = before;
    if (account === undefined) throw new Error(`this test needs a Google Antigravity login of the auth profile "${LIVE_AUTH_PROFILE}"; add one with FLYWHEEL_AUTH_PROFILE=${LIVE_AUTH_PROFILE} ${GOOGLE_ANTIGRAVITY_LOGIN_COMMAND}`);
    const auth = googleAntigravityModule.contributions[0].value.definition.auth;
    const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
    const launcher = createLauncherScope(supervisor);
    // A sign-in URL means agy needs the person, who is not here: the login ends at once instead of waiting.
    const needsPerson = new AbortController();
    const urls: string[] = [];
    try {
      const again = await auth.login(authDir, {
        launcher, signal: AbortSignal.any([needsPerson.signal, AbortSignal.timeout(90_000)]),
        openBrowser: async () => false,
        onAuthorizeUrl: ({ url }) => { urls.push(url); needsPerson.abort(); },
      }, account);
      expect(again).toEqual(account);
      expect(urls).toEqual([]);
      expect(antigravityAccounts(authDir)).toEqual(before);
    } finally {
      await launcher.close();
      await supervisor.dispose();
    }
  }, 120_000);
});
