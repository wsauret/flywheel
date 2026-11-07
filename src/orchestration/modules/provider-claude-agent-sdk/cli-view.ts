import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AnthropicOperations } from "../../agent-runtime/llm/anthropic.js";
import { parseClaudeReminder, type ClaudeReminder } from "../../agent-runtime/llm/claude-reminders.js";
import type { BlockOrigin, BlockOrigins } from "../../agent-runtime/llm/conversions/anthropic-messages.js";
import { ANTHROPIC_RESERVED_BODY_KEYS } from "../../../infra/llm/provider-options.js";
import { ProviderRequestValidationError } from "../../agent-runtime/llm/errors.js";
import { CLAUDE_AGENT_SDK_LABEL, TOOL_MCP_PREFIX } from "./names.js";

/** The prepared request that the shared Anthropic adapter hands to the bridge. */
export type BridgeRequest = Parameters<AnthropicOperations["createStream"]>[0];

type CliResultBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: ImageBlockParam["source"] };

/** The blocks that the shared Anthropic projection sends, without cache marks. */
export type CliBlock =
  | CliResultBlock
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: readonly CliResultBlock[]; readonly is_error?: true };

/** One message as the CLI holds it. */
export interface CliMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly CliBlock[];
}

/** A Flywheel reminder that the view removed, with the index of the view message that held it. */
export interface PlacedReminder {
  readonly message: number;
  readonly reminder: ClaudeReminder;
}

/** A tool as the `runtime` MCP server declares it to the CLI. */
export interface CliTool {
  /** The MCP name, without `mcp__runtime__`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** What one CLI query fixes at launch. A difference in any field needs a new query. Every field except the system
 *  prompt, the directory, and the effort level is also a value of the chat tree's shared agent host (`engineValues`,
 *  `HostPlace`), and so is whether the request states an effort. A per-agent difference in one of those values starts
 *  another engine process. If such a difference is absolutely necessary, add its field to
 *  `HOST_SPLIT_EXCEPTIONS` (agent-host/host-registry.ts) with its reason. */
export interface QueryIdentity {
  /** The text of each system block, in order: the stable tier first, then the session tier. */
  readonly systemPrompt: readonly string[];
  readonly tools: readonly CliTool[];
  /** The thinking field as the native request states it. The CLI sends it in its body (`CLAUDE_CODE_EXTRA_BODY`). */
  readonly thinking: BridgeRequest["thinking"];
  readonly toolChoice: BridgeRequest["tool_choice"];
  readonly maxTokens: number;
  /** The fields of the user's `extra_body` that the shared adapter merged into the request: every field outside the
   *  request fields that it owns. The CLI sends them in its body (`CLAUDE_CODE_EXTRA_BODY`), as native does. */
  readonly extraBody: { readonly [field: string]: unknown };
  /** The working directory of the latest Flywheel environment reminder, else the project root. The CLI writes
   *  its own environment reminder from this directory, so it must equal the one in canonical history. */
  readonly cwd: string;
  /** Whether the request's tools stream their input as the model writes it (`eager_input_streaming`). The CLI sets
   *  the field on every tool that it declares, or on none (`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`). */
  readonly eagerInputStreaming: boolean;
  /** Whether the request carries a cache mark. The engine marks every request of a query that does not start with
   *  `DISABLE_PROMPT_CACHING`, and a native request without a mark is one that Flywheel asked to keep uncached. */
  readonly promptCaching: boolean;
  /** The request's effort. The engine sends its own default effort unless its query starts with
   *  `CLAUDE_CODE_EFFORT_LEVEL=unset`. On a per-turn-effort model it also copies the effort of each earlier turn into
   *  the conversation, where native copies only the request's effort (`withPerTurnEffort`), so every turn of a query
   *  must run at one effort. */
  readonly effort: EffortLevel | undefined;
}

/** A request reduced to what the CLI holds. */
export interface CliView {
  readonly messages: readonly CliMessage[];
  readonly reminders: readonly PlacedReminder[];
  readonly identity: QueryIdentity;
  /** The origin of each block of `messages` (`PreparedAnthropicRequest.origins`). */
  readonly origins: BlockOrigins;
}

/** Whether a block of this origin is a Flywheel reminder, which the view removes because the engine writes its own
 *  copy: an environment or date reminder, or the model reminder. */
export function isReminder(origin: BlockOrigin): boolean {
  return origin === "runtime-reminder" || origin === "claude-framing";
}

/**
 * Reduces a prepared request to the conversation and the query identity that the CLI holds. Cache marks are
 * removed, because the CLI places its own, and the identity keeps only whether the request carries one. Every
 * Flywheel reminder block is split out with its position, because the CLI writes its own copy
 * of each reminder. `origins` (`PreparedAnthropicRequest.origins`) decides which blocks are reminders, and only an
 * environment reminder sets the working directory, so a person's text with a reminder's bytes stays the person's text
 * (ARCH-PROVIDERS-067). The shared projection already sends each run of user messages as one message. The function
 * throws a typed validation error for a request that the bridge cannot represent.
 */
export function cliView(request: BridgeRequest, origins: BlockOrigins, projectRoot: string): CliView {
  if (request.stop_sequences !== undefined && request.stop_sequences.length > 0) throw invalid("the CLI cannot send stop sequences");
  const messages: CliMessage[] = [];
  const reminders: PlacedReminder[] = [];
  const viewOrigins: BlockOrigin[][] = [];
  let cwd: string | undefined;
  let markedBlock = false;
  for (const [index, message] of request.messages.entries()) {
    // The engine writes its own copy of the effort; only the first-party route's request holds one (`withPerTurnEffort`).
    if (message.role === "system") throw invalid("a system message holds the effort, which the engine sends itself");
    if (typeof message.content === "string") throw invalid("a message holds string content instead of blocks");
    if (messages.at(-1)?.role === message.role) throw invalid(`message ${messages.length} repeats the role ${message.role}`);
    const content: CliBlock[] = [];
    const contentOrigins: BlockOrigin[] = [];
    for (const [at, block] of message.content.entries()) {
      markedBlock ||= markable(block).some(marked);
      const origin = origins[index]?.[at];
      if (origin === undefined) throw invalid(`block ${at} of message ${index} has no origin`);
      const reminder = isReminder(origin) && block.type === "text" ? parseClaudeReminder(block.text, cwd) : undefined;
      if (reminder === undefined) {
        content.push(cliBlock(block));
        contentOrigins.push(origin);
        continue;
      }
      reminders.push({ message: messages.length, reminder });
      if (reminder.kind === "environment" || reminder.kind === "environment-update") cwd = reminder.workingDirectory ?? cwd;
    }
    messages.push({ role: message.role, content });
    viewOrigins.push(contentOrigins);
  }
  const tools = request.tools ?? [];
  const system = request.system === undefined ? [] : typeof request.system === "string" ? [{ type: "text" as const, text: request.system }] : request.system;
  const eager = tools.filter((tool) => "eager_input_streaming" in tool && tool.eager_input_streaming === true).length;
  if (eager > 0 && eager < tools.length) throw invalid("the CLI streams the input of every tool or of none, and the tools differ");
  return {
    messages,
    reminders,
    origins: viewOrigins,
    identity: {
      systemPrompt: system.map(({ text }) => text),
      tools: tools.map(cliTool),
      thinking: request.thinking,
      toolChoice: request.tool_choice,
      maxTokens: request.max_tokens,
      extraBody: Object.fromEntries(Object.entries(request).filter(([field]) => !ANTHROPIC_RESERVED_BODY_KEYS.has(field))),
      // A hosted agent's directory is no part of its host's key: only the git status of the directory is
      // (`HostPlace.gitRepository`). Do not make another value of the host place depend on the directory, because a
      // per-agent difference starts another engine process and must be in `HOST_SPLIT_EXCEPTIONS` with its reason.
      cwd: cwd ?? projectRoot,
      eagerInputStreaming: tools.length > 0 && eager === tools.length,
      promptCaching: markedBlock || [...system, ...tools].some(marked),
      effort: request.output_config?.effort ?? undefined,
    },
  };
}

/** A part of a request that can carry a cache mark: a system block, a message block, or a tool. */
type MarkablePart = ContentBlockParam | ToolResultPart | NonNullable<BridgeRequest["tools"]>[number];

/** A block that a tool result holds. */
type ToolResultPart = Exclude<Extract<ContentBlockParam, { type: "tool_result" }>["content"], string | undefined>[number];

/** A message block and, for a tool result, each block that it holds. */
function markable(block: ContentBlockParam): readonly MarkablePart[] {
  return block.type === "tool_result" && Array.isArray(block.content) ? [block, ...block.content] : [block];
}

function marked(part: MarkablePart): boolean {
  return "cache_control" in part && part.cache_control !== null && part.cache_control !== undefined;
}

/** Equality that ignores object key order, for comparing what the CLI holds with a new request. */
export function sameCliValue(left: unknown, right: unknown): boolean {
  return orderedJson(left) === orderedJson(right);
}

/** The first identity field that differs, or undefined when one query serves both. */
export function identityDifference(held: QueryIdentity, requested: QueryIdentity): keyof QueryIdentity | undefined {
  const fields: readonly (keyof QueryIdentity)[] = ["systemPrompt", "tools", "thinking", "toolChoice", "maxTokens", "extraBody", "cwd", "eagerInputStreaming", "promptCaching", "effort"];
  return fields.find((field) => !sameCliValue(held[field], requested[field]));
}

/** JSON text that ignores object key order, so two equal values give one text. */
export function orderedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);
}

function cliBlock(block: ContentBlockParam): CliBlock {
  switch (block.type) {
    case "text": return { type: "text", text: block.text };
    case "image": return { type: "image", source: block.source };
    case "thinking": return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking": return { type: "redacted_thinking", data: block.data };
    case "tool_use": return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      if (typeof block.content === "string") throw invalid("a tool result holds string content instead of blocks");
      const content = (block.content ?? []).map((part): CliResultBlock => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") return { type: "image", source: part.source };
        throw invalid(`a tool result holds a ${part.type} block`);
      });
      return { type: "tool_result", tool_use_id: block.tool_use_id, content, ...(block.is_error === true ? { is_error: true } : {}) };
    }
    default: throw invalid(`a message holds a ${block.type} block`);
  }
}

function cliTool(tool: NonNullable<BridgeRequest["tools"]>[number]): CliTool {
  if (!tool.name.startsWith(TOOL_MCP_PREFIX)) throw invalid(`the tool ${tool.name} lacks the runtime tool prefix`);
  return { name: tool.name.slice(TOOL_MCP_PREFIX.length), description: tool.description ?? "", inputSchema: tool.input_schema };
}

function invalid(issue: string): ProviderRequestValidationError {
  return new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, issue);
}
