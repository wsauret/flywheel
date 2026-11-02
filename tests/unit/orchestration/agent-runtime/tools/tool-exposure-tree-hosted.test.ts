import { describe, expect, it } from "bun:test";
import type { HandoffToolSchema } from "../../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import type { ConversationCheckpointOwner } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { testSkill } from "../../../../helpers/skill-fixtures.js";
import { makeContext } from "./_fixtures.js";
import { ALL_CAPABILITIES, askUserController, plan, skillRevision, subagentsRuntime } from "./_planner-fixtures.js";

/** A definition override service with something to review. A resolution
 *  would fail, which no exposure test performs. */
function definitionOverridesService() {
  return {
    available: () => true,
    subscribe: () => () => {},
    list: async () => ({ overrides: [], diagnostics: [] }),
    diff: async () => { throw new Error("unused in this test"); },
    prepare: async () => { throw new Error("unused in this test"); },
    apply: async () => {},
    refresh: async () => {},
    proposal: () => undefined,
    finalizeSkillPublication: async () => {},
  };
}

describe("tool exposure of a tree-hosted agent", () => {
  it("advertises a tree-hosted agent's surface-less tools with a surfaced agent's bytes and refuses their calls", async () => {
    const unused = async (): Promise<never> => { throw new Error("Unused checkpoint write"); };
    const checkpoint: ConversationCheckpointOwner = { read: async () => undefined, replace: unused, decide: unused };
    const schema: HandoffToolSchema = { input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } };
    const advertised = (tool: RuntimeTool | undefined) => tool && JSON.stringify({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines,
    });
    const surfaced = await plan({ checkpoint, handoff: { schema } });
    const hosted = await plan({ treeHosted: true });
    const chat = await plan();
    const names = ["checkpoint_read", "checkpoint_replace", "checkpoint_decide", "handoff"];
    for (const name of names) {
      expect(advertised(hosted.tools.get(name)), name).toBe(advertised(surfaced.tools.get(name)));
      expect(surfaced.usable.has(name), name).toBe(true);
      expect(hosted.usable.has(name), name).toBe(false);
      expect(chat.tools.has(name), name).toBe(false);
    }
    expect(await hosted.tools.get("checkpoint_read")?.execute({}, makeContext())).toEqual({
      content: "The checkpoint_read tool is unavailable to this agent now: no owning conversation checkpoint available. Do not call checkpoint_read again.",
      outcome: "error",
    });
    expect(hosted.omitted.map(({ name }) => name)).not.toContain("handoff");
    expect(chat.omitted).toContainEqual({ name: "checkpoint_read", reason: "no owning conversation checkpoint available" });
  });

  it("advertises a tree-hosted agent's surface-less module tools with a surfaced agent's bytes and refuses their calls", async () => {
    const advertised = (tool: RuntimeTool | undefined, withGuidelines = true) => tool && JSON.stringify({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema, promptSnippet: tool.promptSnippet,
      ...(withGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
    });
    const webSearch = { available: () => true, run: async () => { throw new Error("unused in this test"); } };
    const overrides = definitionOverridesService();
    const surfaced = await plan(
      { capabilities: ALL_CAPABILITIES, recall: async () => { throw new Error("unused in this test"); }, skills: skillRevision([testSkill("demo")]) },
      [["web", () => webSearch], ["subagents", subagentsRuntime()], ["definition-overrides", overrides]],
    );
    const asking = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [["definition-overrides", overrides]]);
    const askingWithoutDecisions = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() });
    const hosted = await plan({ capabilities: ALL_CAPABILITIES, treeHosted: true }, [["definition-overrides", { ...overrides, available: () => false }]]);
    const chat = await plan({ capabilities: ALL_CAPABILITIES }, [["definition-overrides", { ...overrides, available: () => false }]]);

    const reasons = {
      web: "no web search provider available (connect ChatGPT or Exa in /auth)",
      recall: "no conversation history available",
      subagent: "no subagent registry available",
      definition_overrides: "no definition override projection available",
      ask_user: "no ask-user controller available",
      skill: "no skill registry available",
    };
    for (const name of ["web", "recall", "subagent", "definition_overrides"]) expect(advertised(hosted.tools.get(name)), name).toBe(advertised(surfaced.tools.get(name)));
    // Whether the agent can ask the person never changes the override tool's bytes.
    expect(advertised(asking.tools.get("definition_overrides"))).toBe(advertised(surfaced.tools.get("definition_overrides")));
    expect(advertised(hosted.tools.get("ask_user"))).toBe(advertised(askingWithoutDecisions.tools.get("ask_user")));
    // The catalog guidelines render the skill revision, which the system prompt carries.
    expect(advertised(hosted.tools.get("skill"), false)).toBe(advertised(surfaced.tools.get("skill"), false));
    for (const [name, reason] of Object.entries(reasons)) {
      expect(hosted.usable.has(name), name).toBe(false);
      expect(await hosted.tools.get(name)?.execute({}, makeContext()), name).toEqual({
        content: `The ${name} tool is unavailable to this agent now: ${reason}. Do not call ${name} again.`,
        outcome: "error",
      });
      expect(chat.tools.has(name), name).toBe(false);
      expect(chat.omitted, name).toContainEqual({ name, reason });
    }
  });

  it("settles a tree-hosted agent's refinements against the tools it can call, not the ones it only advertises", async () => {
    let preparations = 0;
    const overrides = { ...definitionOverridesService(), prepare: async () => { preparations += 1; throw new Error("must not prepare"); } };
    const hosted = await plan({ capabilities: ALL_CAPABILITIES, treeHosted: true }, [["definition-overrides", overrides]]);

    expect(hosted.tools.has("ask_user")).toBe(true);
    expect(hosted.tools.has("message_session")).toBe(true);
    const refused = await hosted.tools.get("definition_overrides")?.execute({ action: "keep-mine", path: "/project/demo.md" }, makeContext());
    expect(refused?.outcome).toBe("error");
    expect(refused?.content).toContain("Resolving an override requires the Ask User capability");
    expect(refused?.content).toContain("no parent can answer during this run");
    expect(preparations).toBe(0);
  });
});
