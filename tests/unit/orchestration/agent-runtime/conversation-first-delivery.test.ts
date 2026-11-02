import { describe, expect, it } from "bun:test";
import {
  buildSystemPrompt,
  type ToolPromptFields,
} from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt, SYSTEM_PROMPT_SEPARATOR as SEPARATOR } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const ACTIONS = new Map<string, ToolPromptFields["action"]>([["edit", "file_edit"], ["read", "file_read"], ["subagent", "task_subagent"], ["ask_user", "ask_user"]]);

function tool(name: string): ToolPromptFields {
  return { name, action: ACTIONS.get(name) ?? "ui_meta", description: `${name} tool` };
}

function chatPrompt(tools: ToolPromptFields[]): string {
  return renderSystemPrompt(buildSystemPrompt({
    corePrompt: "core",
    tools,
    promptKind: "chat",
    chatHost: { communication: true },
  }));
}

const HEADER = "CONVERSATION-FIRST DELIVERY:";

function deliveryBlock(prompt: string): string {
  const start = prompt.indexOf(HEADER);
  const end = prompt.indexOf(SEPARATOR, start);
  return prompt.slice(start, end === -1 ? undefined : end);
}

describe("conversation-first delivery guidance", () => {
  it("defines chat completion once and keeps the design approval boundary", () => {
    const result = chatPrompt([tool("edit"), tool("ask_user")]);

    expect(result).toContain("a change request is complete when the change is designed, implemented, verified, and reviewed");
    expect(result).toContain("Completing one part starts the next");
    expect(result).toContain("Design approval is asked once per design through `ask_user` when no existing scope approval covers the work");
    expect(result).toContain("existing scope approval covers independent fixes and in-scope revisions");
    expect(result).toContain("a plain affirmative approves the design and its route and executes it immediately");
  });

  it("names every route's result a first draft and leaves the revision method to the chat change review block", () => {
    const result = chatPrompt([tool("edit"), tool("subagent"), tool("ask_user")]);

    expect(result).toContain("Every route returns a first draft of the approved design; the chat change review pass turns it into the finished change");
    expect(result).not.toContain("realign what missed the intent");
  });

  it("leads feasibility and confirmed diagnosis into the design skill without another request", () => {
    const result = chatPrompt([tool("read"), tool("edit"), tool("subagent"), tool("ask_user")]);

    expect(result).toContain("A request to design, plan, brainstorm, or assess a proposed feature's feasibility starts the design process");
    expect(result).toContain("a confirmed bug cause starts fix design");
    expect(result).toContain("load the `design` skill, which owns the method, the recommended implementation route, and the approval mechanics");
    expect(result).toContain("do not stop at a feasibility verdict, a diagnosis, design approval, or intent publication");
    expect(result).toContain("Ask the user for decisions, never for permission to advance");
    expect(result).toContain("Pure information questions need answers, not implementation");
    expect(result).toContain("A question that implies a preference about current work, such as why two tasks cannot run in parallel, is a steer: answer it and act on it in the same turn.");
    expect(result).toContain("Explicit advice-only, investigation-only, or design-only limits remain binding");
    expect(result).toContain("A design that you show the user rests on a spike that tested it");
  });

  it("gives a shape guide after publication and answers review questions on published code", () => {
    const result = chatPrompt([tool("read"), tool("edit"), tool("subagent"), tool("ask_user")]);

    expect(result).toContain("After each publication, your reply ends with a section headed Shape guide that you write from the reviewed deviations and fresh verification, with four labeled items");
    expect(result).toContain("Departures, each departure from the approved design with its reason, or None; Proof, what ran and what it showed");
    expect(result).toContain("A pull request description gives the same guide");
    expect(result).toContain("Do not stop before publication to ask for a shape review");
    expect(result).toContain("Answer a question about published code by explaining the code first; a question that needs only an explanation ends there");
    expect(result).toContain("A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape");
    expect(result).toContain("Never send the user to read a file to understand the work");
    expect(result).toContain("restate their model, name the exact premise where you differ, settle facts with evidence without defending or conceding by reflex, and leave preferences to the user");
  });

  // The block states the completion contract; the design skill owns the
  // method. A regrowth past one paragraph means method text leaked back in.
  it("stays one paragraph and names no route or method detail", () => {
    const block = deliveryBlock(chatPrompt([tool("read"), tool("edit"), tool("subagent"), tool("ask_user")]));

    expect(block.startsWith(HEADER)).toBe(true);
    expect(block.length).toBeLessThan(2000);
    expect(block.trim().split("\n")).toHaveLength(2);
    expect(block).not.toContain("inline, subagent, implement, or implement-and-review");
    expect(block).not.toContain("Recommended implementation route");
    expect(block).not.toContain("protocol violation");
  });

  it("stays out of non-interactive and read-only prompts", () => {
    const worker = renderSystemPrompt(buildSystemPrompt({
      corePrompt: "core",
      tools: [tool("edit"), tool("subagent")],
      promptKind: "workflow-agent",
      unattended: true,
    }));

    expect(worker).not.toContain(HEADER);
    expect(worker).not.toContain("a confirmed bug cause starts fix design");
    expect(worker).not.toContain("Completing one part starts the next");
    expect(chatPrompt([tool("read")])).not.toContain(HEADER);
    expect(chatPrompt([tool("read"), tool("edit")])).not.toContain(HEADER);
  });
});
