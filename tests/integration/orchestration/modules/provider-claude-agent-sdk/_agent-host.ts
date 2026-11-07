/**
 * The agent loop and the scripted dispatcher of the shared agent host tests: a fake host's requests read as the
 * dispatcher's and the agents' own, and one agent loop that drives a staged client as the production loop does.
 */
import type { ConversationMessage, StreamOptions, ToolDef } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { applyContentRepairs } from "../../../../../src/orchestration/agent-runtime/llm/content-repair.js";
import { projectToolHistory } from "../../../../../src/orchestration/agent-runtime/llm/tool-history-projection.js";
import type { SystemPromptTiers } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { HostRegistry } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import { assistantMessage, type StagedSdkClient, type StreamResult } from "./_claude-sdk-client.js";
import { declaredTools, type FakeReply, type RecordedRequest } from "./_fake-host.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

export const LOOKUP = { name: "lookup", description: "Looks a key up.", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
export const SYSTEM = { stable: "You are a careful worker.", session: "Session tail.", conversation: "" };
export const TREE = "tree-root-session";

export type WireBlock = { readonly type: string; readonly text?: string; readonly tool_use_id?: string; readonly is_error?: boolean; readonly content?: unknown };
type WireMessage = { readonly role: string; readonly content: string | readonly WireBlock[] };

export function wireMessages(request: RecordedRequest): readonly WireMessage[] {
  const messages = request.body["messages"];
  return Array.isArray(messages) ? messages : [];
}

/** The text blocks of the newest user message of a request. */
export function lastUserTexts(request: RecordedRequest): readonly string[] {
  const last = wireMessages(request).findLast((message) => message.role === "user");
  if (last === undefined) return [];
  return typeof last.content === "string" ? [last.content] : last.content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []);
}

/** The text of each system block of a request. */
export function systemTexts(request: RecordedRequest): readonly string[] {
  const blocks = request.body["system"];
  return Array.isArray(blocks) ? blocks.flatMap((block: { readonly text?: unknown }) => typeof block.text === "string" ? [block.text] : []) : [];
}

/** The text of a canonical message, or nothing for a message of blocks. */
export const textOf = (message: ConversationMessage): string | undefined => message.kind === "user" && typeof message.content === "string" ? message.content : undefined;

export const isDispatcher = (request: RecordedRequest) => declaredTools(request.body).includes("SendMessage");

/** The dispatcher's answers: one SendMessage per agent id that its frame names, then a short reply. Each agent's
 *  answers come from `agent`. */
export function hostScript(agent: (request: RecordedRequest, index: number) => FakeReply) {
  return (request: RecordedRequest, index: number): FakeReply => {
    if (!isDispatcher(request)) return agent(request, index);
    const last = wireMessages(request).findLast((message) => message.role === "user");
    if (last !== undefined && typeof last.content !== "string" && last.content.some((block) => block.type === "tool_result")) return { blocks: [{ text: "Sent" }] };
    const ids = lastUserTexts(request).join("\n").match(/\ba[0-9a-f]{16}\b/gu) ?? [];
    return { blocks: ids.map((to) => ({ tool: "SendMessage", input: { to, message: "Continue." } })) };
  };
}

/** An agent's answers: a lookup first, then the answer after its result. */
export const lookupThenAnswer = (request: RecordedRequest): FakeReply => {
  const last = wireMessages(request).findLast((message) => message.role === "user");
  const hasResult = last !== undefined && typeof last.content !== "string" && last.content.some((block) => block.type === "tool_result");
  return hasResult ? { blocks: [{ thinking: "I have the value." }, { text: "The value is ready." }] } : { blocks: [{ thinking: "I need the value." }, { tool: "lookup", input: { key: "k" } }] };
};

/** The request's view of history as the production preparation makes it after the loop's mask
 *  (`createActiveRequestContext`): content repairs, then the projection of each tool call whose contract the request
 *  does not declare into neutral context. Each tool here has one contract, named by its tool name, so a call stays
 *  native exactly when the request declares its tool. */
function projected(messages: readonly ConversationMessage[], tools: readonly ToolDef[]): ConversationMessage[] {
  const registration = (name: string) => `registration:${name}`;
  return projectToolHistory({
    messages: applyContentRepairs(messages),
    activeRegistrationIds: new Map(tools.map(({ name }) => [name, registration(name)])),
    historicalRegistrationId: (_message, block) => registration(block.name),
  }).messages;
}

/** One agent loop over a staged client: history, the client's appends and request entries before each request, and
 *  the stored answers.
 *  `tools` are the tools of its next request. */
export function agentLoop(client: StagedSdkClient, projectRoot: string, brief: string, systemPrompt: SystemPromptTiers = SYSTEM) {
  const history: ConversationMessage[] = [{ kind: "user", origin: "human", content: brief }];
  let connected: Awaited<ReturnType<StagedSdkClient["connect"]>> | undefined;
  const firstTools: readonly ToolDef[] = [LOOKUP];
  // A function return keeps the field's declared union; a constant would narrow it to "medium".
  const firstEffort = (): StreamOptions["reasoningEffort"] => "medium";
  const noRequestContext = (): string | undefined => undefined;
  const noPause = (): (() => Promise<void>) | undefined => undefined;
  const noProviderOptions = (): StreamOptions["providerOptions"] => undefined;
  const loop = {
    history,
    tools: firstTools,
    effort: firstEffort(),
    /** The role's provider options of each request, such as its thinking display. */
    providerOptions: noProviderOptions(),
    /** The loop's outbound preparation of its history, such as the stale tool-result mask. */
    outbound: (messages: readonly ConversationMessage[]): ConversationMessage[] => [...messages],
    /** The request-only text of the next request, such as the continuation after a stall, which history never holds. */
    requestContext: noRequestContext(),
    /** Runs after the route's entries read the request and before the client receives it, where the request waits on
     *  its records. */
    beforeStream: noPause(),
    async request(signal?: AbortSignal, onEvent?: Parameters<Awaited<ReturnType<StagedSdkClient["connect"]>>["stream"]>[1]): Promise<StreamResult> {
      const { tools, effort, requestContext, providerOptions } = loop;
      const { attempt } = client.staged;
      history.push(...attempt.messagesToAppend?.(history, projectRoot, SHELL_CAPABILITIES) ?? []);
      connected ??= await client.connect();
      const prepared = (): StreamOptions => ({
        messages: [...projected(loop.outbound(history), tools), ...(requestContext === undefined ? [] : [{ kind: "user" as const, content: requestContext, requestOnly: true as const }])],
        tools, systemPrompt, reasoningEffort: effort, ...(signal === undefined ? {} : { signal }), ...(requestContext === undefined ? {} : { requestContext }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
      });
      // The route's entries read the request as prepared, and the request is prepared again with them.
      history.push(...attempt.requestEntries?.(prepared()) ?? []);
      await loop.beforeStream?.();
      const result = await connected.stream(prepared(), onEvent);
      if (result.error === undefined) history.push(assistantMessage(result));
      return result;
    },
    result(toolUseId: string, text: string, isError?: true) {
      history.push({ kind: "toolResult", toolUseId, content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
    },
  };
  return loop;
}

/** The agent id that each dispatcher request of `host` sent its message to, in order. */
export function dispatchedIds(requests: readonly RecordedRequest[]): readonly string[] {
  return requests.filter(isDispatcher).flatMap((request) => lastUserTexts(request).join("\n").match(/\ba[0-9a-f]{16}\b/gu) ?? []);
}

/** The effort that a request states. */
export function effortOf(request: RecordedRequest): string | undefined {
  const config = request.body["output_config"];
  return typeof config === "object" && config !== null && "effort" in config && typeof config.effort === "string" ? config.effort : undefined;
}

/** The dispatcher requests that a hosted request's transport record names. */
export function hiddenRequests(result: StreamResult) {
  return result.events.flatMap((event) => event.kind === "transport_context" ? event.context.hiddenRequests : []);
}

/** A registry that forwards to the test's current registry, read when the client asks, so each case's own registry serves it. */
export function registryProxy(current: () => HostRegistry): HostRegistry {
  return { lease: (...input) => current().lease(...input), drain: (...input) => current().drain(...input) };
}
