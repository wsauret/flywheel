import { describe, expect, it } from "bun:test";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ResolvedRole, ResolvedRoles } from "../../../../../src/orchestration/config/roles.js";
import {
  digestConversation,
  resolveReviewRoute,
  reviewReplay,
} from "../../../../../src/orchestration/modules/learning/learning-review.js";
import { resolveSessionRoles } from "../../../../../src/orchestration/config/session-role-resolver.js";
import { roleCapture } from "../../../../helpers/role-capture.js";

describe("review route resolution", () => {
  function roles(entries: ResolvedRole[]): ResolvedRoles {
    return new Map(entries.map((role) => [role.roleId, role]));
  }
  const parent: ResolvedRole = { roleId: "chat", model: "main-model", effort: "medium" };
  const orchestrator: ResolvedRole = { roleId: "workflow-agent", model: "orchestrator-model", effort: "high" };

  it("resolves Learning Review from policy when an old session has no review setting", async () => {
    const current = await resolveSessionRoles({ defaults: {}, overrides: { "workflow-agent": { model: "gpt-6-astra", effort: "high" } } }, roleCapture(["gpt-6.1-sol", "gpt-6-astra"]), "/scratch");
    const route = resolveReviewRoute(current, parent);
    expect(route.role).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
    expect(route.routed).toBe(true);
  });

  it("uses an explicit Learning Review role without routing when it names the parent model", () => {
    const aux: ResolvedRole = { roleId: "learning-review", model: "main-model", effort: "low" };
    const route = resolveReviewRoute(roles([parent, orchestrator, aux]), parent);
    expect(route.role).toBe(aux);
    expect(route.routed).toBe(false);
  });

  it("replays the identical full history on the parent model and the digest with its recent tail on a routed model", async () => {
    const history: ConversationMessage[] = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0 ? { kind: "user", content: `question-${index}` } : { kind: "assistant", content: `answer-${index}` });
    const sameModel = resolveReviewRoute(roles([parent, orchestrator, { roleId: "learning-review", model: "main-model", effort: "low" }]), parent);
    const alternateModel = resolveReviewRoute(roles([parent, orchestrator, { roleId: "learning-review", model: "review-model", effort: "medium" }]), parent);

    expect(await reviewReplay(sameModel, history)).toBe(history);
    const routed = await reviewReplay(alternateModel, history);
    expect(routed).toEqual(await digestConversation(history));
    expect(routed.slice(1)).toEqual(history.slice(-24));
  });
});

describe("digestConversation", () => {
  function user(text: string): ConversationMessage {
    return { kind: "user", content: text };
  }
  function assistant(text: string, toolNames: string[] = []): ConversationMessage {
    return {
      kind: "assistant",
      content: [
        { type: "text" as const, text },
        ...toolNames.map((name) => ({ type: "tool_use" as const, id: `use-${name}`, name, input: { secret: "argument" } })),
      ],
    };
  }
  function toolResult(text: string): ConversationMessage {
    return { kind: "toolResult", toolUseId: "use-x", content: [{ type: "text", text }] };
  }

  it("returns short conversations verbatim", async () => {
    const messages = [user("hello"), assistant("hi")];
    expect(await digestConversation(messages)).toEqual(messages);
  });

  it("keeps the recent tail verbatim and collapses older turns into one synthetic user digest", async () => {
    const older = [user("first question"), assistant("first answer", ["bash"]), toolResult("old tool output")];
    const tail: ConversationMessage[] = [];
    for (let i = 0; i < 24; i++) tail.push(i % 2 === 0 ? user(`recent-${i}`) : assistant(`reply-${i}`));

    const digest = await digestConversation([...older, ...tail]);

    expect(digest).toHaveLength(25);
    expect(digest.slice(1)).toEqual(tail);
    const head = digest[0];
    if (head?.kind !== "user" || typeof head.content !== "string") throw new Error("expected synthetic user digest");
    expect(head.content).toContain("USER: first question");
    expect(head.content).toContain("ASSISTANT[tools: bash]");
    expect(head.content).toContain("ASSISTANT: first answer");
    // Tool arguments and old tool results never enter the digest.
    expect(head.content).not.toContain("argument");
    expect(head.content).not.toContain("old tool output");
  });

  it("extends the tail past leading tool results so the replay never opens mid-tool-exchange", async () => {
    const older = [user("ancient")];
    const boundary = [assistant("calling", ["bash"]), toolResult("tool output"), toolResult("more output")];
    const tail: ConversationMessage[] = [];
    for (let i = 0; i < 22; i++) tail.push(i % 2 === 0 ? user(`recent-${i}`) : assistant(`reply-${i}`));

    // A 24-message tail would open on the toolResult pair; the tail must
    // stretch to include their assistant tool_use message.
    const digest = await digestConversation([...older, ...boundary, ...tail]);

    expect(digest[0]?.kind).toBe("user");
    expect(digest[1]).toEqual(boundary[0]);
    expect(digest[2]).toEqual(boundary[1]);
  });

  it("returns everything verbatim when tail extension reaches the start of the conversation", async () => {
    const messages: ConversationMessage[] = [assistant("calling", ["bash"])];
    for (let i = 0; i < 25; i++) messages.push(toolResult(`output-${i}`));
    expect(await digestConversation(messages)).toEqual(messages);
  });

  it("truncates collapsed user lines to 300 chars and assistant lines to 200", async () => {
    const older = [user("u".repeat(500)), assistant("a".repeat(500))];
    const tail: ConversationMessage[] = [];
    for (let i = 0; i < 24; i++) tail.push(user(`recent-${i}`));

    const digest = await digestConversation([...older, ...tail]);
    const head = digest[0];
    if (head?.kind !== "user" || typeof head.content !== "string") throw new Error("expected synthetic user digest");
    expect(head.content).toContain(`USER: ${"u".repeat(300)}\n`);
    expect(head.content).not.toContain("u".repeat(301));
    expect(head.content).toContain(`ASSISTANT: ${"a".repeat(200)}`);
    expect(head.content).not.toContain("a".repeat(201));
  });
});
