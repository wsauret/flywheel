import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, buildSystemPromptParts, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt, stableSystemPrompt, SYSTEM_PROMPT_SEPARATOR } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { withSessionNotes } from "./context/_loop-fixtures.js";
import { toAnthropicMessagesRequest } from "../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages.js";
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ModelInfo } from "../../../../src/infra/llm/models.js";
import { prepareOpenAICompletionsRequest } from "../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { resolveOpenAISystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js";
import { promptOptions } from "../../../helpers/prompt-capabilities.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { fileTemporaryDirectory, testDirectories } from "../../../helpers/directories.js";

const realm = testDirectories(fileTemporaryDirectory("system-prompt-tiers-"));
const SESSION_DIR = "/realm/.flywheel/sessions/abc123def456/scratch";

function spec(name: string, opts: Partial<ToolPromptFields> = {}): ToolPromptFields {
  return { action: "ui_meta", description: `${name} tool`, ...opts, name };
}

const noteTools = [...withSessionNotes().tools.values()];
const tools: ToolPromptFields[] = [
  spec("bash", { action: "shell_exec" }),
  spec("ask_user"),
  spec("recall"),
  spec("subagent"),
  ...noteTools,
];

const chatOptions = {
  corePrompt: "CORE",
  engineeringDoctrine: "DOCTRINE",
  agentsMd: "AGENTS",
  tools,
  scratchDir: SESSION_DIR,
  checkpointAvailable: true,
  promptKind: "chat" as const,
  chatHost: { communication: true as const },
  moduleFragments: ["# Durable Memory\n\nremembered"],
  envBlock: "<env>cwd</env>",
};

describe("system prompt cache tiers", () => {
  test("the stable parts precede the session parts, which precede the conversation parts", () => {
    const parts = buildSystemPromptParts(promptOptions(chatOptions));
    const order = ["stable", "session", "conversation"];
    expect(parts.map((part) => order.indexOf(part.tier))).toEqual(parts.map((part) => order.indexOf(part.tier)).toSorted());
    expect(parts.filter((part) => part.tier === "session").map((part) => part.label)).toEqual([
      "scratchpad", "module fragment", "env",
    ]);
    expect(parts.filter((part) => part.tier === "conversation").map((part) => part.label)).toEqual(["session checkpoint"]);
    expect(parts.find((part) => part.label === "AGENTS.md instructions")?.tier).toBe("stable");
  });

  test("the stable tier carries no session path, and checkpoint guidance needs no filesystem path", () => {
    const { stable, session, conversation } = buildSystemPrompt(promptOptions(chatOptions));
    expect(stable).not.toContain("abc123def456");
    expect(stable).not.toContain(SESSION_DIR);
    expect(session).toContain(SESSION_DIR);
    expect(conversation).toContain("checkpoint_replace");
    expect(conversation).not.toContain(SESSION_DIR);
  });

  test("two sessions of one project share the stable tier byte for byte", () => {
    const other = { ...chatOptions, scratchDir: "/realm/.flywheel/sessions/ffff0000/scratch" };
    const otherTools = [...withSessionNotes().tools.values()];
    const first = buildSystemPrompt(promptOptions(chatOptions));
    const second = buildSystemPrompt(promptOptions({ ...other, tools: [spec("bash", { action: "shell_exec" }), spec("ask_user"), spec("recall"), spec("subagent"), ...otherTools] }));
    expect(second.stable).toBe(first.stable);
    expect(second.session).not.toBe(first.session);
  });

  test("workflow-agent private identity and paths follow all shared request context", () => {
    // The bundled assets carry capability markers, which render from the tree check alone.
    const options = {
      ...chatOptions,
      corePrompt: loadSystemPrompt(realm),
      engineeringDoctrine: loadEngineeringDoctrine(realm),
      chatHost: undefined,
      promptKind: "workflow-agent" as const,
      purpose: { kind: "workflow-agent", workflowAttemptId: "attempt-a", briefScope: { briefId: "review" } } satisfies AgentPurpose,
      tools: [...tools, spec("message_session"), spec("list_sessions")],
      sessionIdentity: { sessionId: "agent-a", rootSessionId: "chat", conversationId: "conversation-a", kind: "workflow-agent" as const, workflowMembership: { kind: "attempt" as const, workflowId: "run-a", attemptId: "attempt-a" }, parent: { sessionId: "chat", name: "Parent" } },
    };
    const first = buildSystemPrompt(promptOptions(options));
    const second = buildSystemPrompt(promptOptions({
      ...options,
      scratchDir: "/realm/agent-b/scratch",
      sessionIdentity: { ...options.sessionIdentity, sessionId: "agent-b" },
    }));
    expect(second.stable).toBe(first.stable);
    expect(second.session).toBe(first.session);
    expect(second.conversation).not.toBe(first.conversation);
    expect(first.session).toBe(["# Durable Memory\n\nremembered", "<env>cwd</env>"].join(SYSTEM_PROMPT_SEPARATOR));
    expect(first.conversation).toContain(SESSION_DIR);
    expect(first.conversation).toContain("checkpoint_replace");
    expect(first.conversation).toContain("agent-a");
    const parts = buildSystemPromptParts(promptOptions(options));
    const order = ["stable", "session", "conversation"];
    expect(parts.map((part) => order.indexOf(part.tier))).toEqual(parts.map((part) => order.indexOf(part.tier)).toSorted());
    expect(parts.filter((part) => part.tier === "conversation").map((part) => part.label)).toEqual(["scratchpad", "session identity", "session checkpoint"]);
  });

  test.each([
    { kind: "interactive-chat" },
    { kind: "subagent", renderAs: "subagent", parentToolUseId: "dispatch" },
    { kind: "subagent", renderAs: "workflow-agent", parentToolUseId: "dispatch" },
    { kind: "workflow-follow-up" },
  ] satisfies AgentPurpose[])("purpose $kind preserves non-workflow-agent prompt bytes", (purpose) => {
    const options = {
      ...chatOptions,
      promptKind: purpose.kind === "interactive-chat" ? "chat" as const : "workflow-agent" as const,
      tools: [...tools, spec("message_session"), spec("list_sessions")],
      sessionIdentity: { sessionId: "child", rootSessionId: "chat", conversationId: "child-conversation", kind: "subagent" as const, parent: { sessionId: "chat", name: "Parent" } },
    };
    const before = buildSystemPrompt(promptOptions(options));
    expect(buildSystemPrompt(promptOptions({ ...options, purpose }))).toEqual(before);
    expect(before.session).toContain(SESSION_DIR);
    expect(before.session).toContain("child");
    expect(before.conversation).not.toContain("# Session identity");
  });

  test("checkpoint tool definitions carry no conversation-specific path", () => {
    for (const tool of noteTools) {
      expect(tool.description).not.toContain(SESSION_DIR);
      expect(tool.description).toContain("conversation");
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).not.toContain(SESSION_DIR);
      expect(JSON.stringify(tool.inputSchema)).not.toContain(SESSION_DIR);
    }
  });

  test("rendering joins the non-empty tiers in order with the part separator", () => {
    expect(renderSystemPrompt({ stable: "a", session: "b", conversation: "c" })).toBe(`a${SYSTEM_PROMPT_SEPARATOR}b${SYSTEM_PROMPT_SEPARATOR}c`);
    expect(renderSystemPrompt(stableSystemPrompt("only"))).toBe("only");
    expect(renderSystemPrompt({ stable: "", session: "tail", conversation: "" })).toBe("tail");
  });
});

describe("providers without cache breakpoints receive the tiers joined in order", () => {
  const tiers = { stable: "STABLE", session: "SESSION", conversation: "" };
  const joined = `STABLE${SYSTEM_PROMPT_SEPARATOR}SESSION`;
  const options: StreamOptions = { messages: [{ kind: "user", content: "hi", origin: "human" }], tools: [], systemPrompt: tiers, cacheRetention: "none" };
  const info: ModelInfo = {
    provider: "openai", family: "openai", id: "gpt-test", name: "GPT Test", reasoning: false, toolCall: true, attachment: false, temperature: true, openWeights: false,
    cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" }, modalities: { input: ["text"], output: ["text"] }, contextLimit: 20_000, outputLimit: 4_000,
  };

  test("chat completions prepends one system message with the joined text", () => {
    const prepared = prepareOpenAICompletionsRequest({ accessProvider: "openai_api", model: "gpt-test", wireModel: "gpt-test", info, options });
    expect(prepared.params.messages[0]).toEqual({ role: "system", content: joined });
  });

  test("responses instructions carry the joined text", () => {
    expect(resolveOpenAISystemPrompt({ messages: [], systemPrompt: tiers, isChatGPT: false })).toBe(joined);
  });
});

describe("anthropic system blocks", () => {
  const base = { accessProvider: "anthropic_api" as const, provider: "anthropic" as const, api: "anthropic-messages" as const, model: "claude" };
  const history: ConversationMessage[] = [{ kind: "user", content: "hi", origin: "human" }];

  test("each non-empty tier becomes one text block, and the stable and session blocks each end a cache breakpoint", () => {
    const request = toAnthropicMessagesRequest({ sharedHost: false, ...base, systemPrompt: { stable: "STABLE", session: "SESSION", conversation: "CONVERSATION" }, cacheRetention: "1h" }, history);
    expect(request.system).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "SESSION", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "CONVERSATION" },
    ]);
  });

  test("an empty session tier yields a single block, and disabled caching yields no markers", () => {
    expect(toAnthropicMessagesRequest({ sharedHost: false, ...base, systemPrompt: stableSystemPrompt("STABLE"), cacheRetention: "5m" }, history).system)
      .toEqual([{ type: "text", text: "STABLE", cache_control: { type: "ephemeral" } }]);
    expect(toAnthropicMessagesRequest({ sharedHost: false, ...base, systemPrompt: { stable: "S", session: "T", conversation: "" }, cacheRetention: "none" }, history).system)
      .toEqual([{ type: "text", text: "S" }, { type: "text", text: "T" }]);
    expect(toAnthropicMessagesRequest({ sharedHost: false, ...base, systemPrompt: stableSystemPrompt(""), cacheRetention: "5m" }, history).system).toBeUndefined();
  });
});
