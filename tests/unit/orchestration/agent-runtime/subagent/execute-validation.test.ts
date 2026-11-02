import { describe, expect, it } from "bun:test";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createSubagentTool } from "../../../../../src/orchestration/modules/subagents/tool.js";
import { grantOf, makeCapabilityAccess, makeContext, makeDeps, refusedAdmission, TEST_RATIONALE } from "./_fixtures.js";
import type { CapabilityAccess } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { validateToolInput } from "../../../../../src/orchestration/agent-runtime/tools/validate-input.js";

describe("subagent tool — execute validation", () => {
    it("does not advertise a per-dispatch model tier", () => {
      const tool = createSubagentTool(makeDeps());
      const schema = tool.inputSchema;
      // Providers require an object root; a bare union is rejected at request time.
      expect(schema.type).toBe("object");
      const properties = typeof schema.properties === "object" && schema.properties !== null ? Object.keys(schema.properties) : [];

      expect(properties).toEqual(expect.arrayContaining(["persona", "prompt"]));
      // The subagent tool only dispatches: `process` resumes a child.
      expect(properties).not.toContain("kind");
      expect(properties).not.toContain("session_id");
      expect(properties).not.toContain("message");
      expect(properties).not.toContain("tier");
      expect(tool.promptGuidelines?.join("\n")).not.toContain("tier");
      expect(tool.description).not.toContain("tier");
      expect(JSON.stringify(schema.properties)).toContain("permits forked history");
      expect(JSON.stringify(schema.properties)).not.toContain("works with any agent type");
      // Agent selection and fork rules live in the description and the fork
      // field, not in a guideline that restates them.
      expect(JSON.stringify(schema.properties)).toContain("follow the selected persona's restrictions");
      expect(tool.description).toContain("every dispatch MUST pass `persona` as the FIRST field");
      expect(tool.promptGuidelines?.join("\n")).not.toContain("Choosing an agent type");
      expect(JSON.stringify(schema.properties)).not.toContain("FIRST decision");
    });

    it("lets the dispatcher's central validator refuse a dispatch without its rationale and prompt", () => {
      const tool = createSubagentTool(makeDeps());
      expect(validateToolInput({ persona: "explorer" }, tool.inputSchema)).toEqual([
        "The required parameter `rationale` is missing",
        "The required parameter `prompt` is missing",
      ]);
    });

    it("refuses a retired resume or retry call and names process resume", async () => {
      const tool = createSubagentDispatch(makeDeps());
      for (const kind of ["resume", "retry"]) {
        expect(await tool.execute({ kind, session_id: "child-session" }, makeContext())).toEqual({
          outcome: "error",
          content: "The subagent tool only dispatches. Use process(action='resume') with the child's session_id to continue or retry a child.",
        });
      }
    });

    it("returns error for unknown persona", async () => {
      const deps = makeDeps();
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      const result = await tool.execute({ persona: "nonexistent", rationale: TEST_RATIONALE, prompt: "do stuff" }, ctx);
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("subagent failed due to the following issue:");
      expect(result.content).toContain("'nonexistent'");
      expect(result.content).toContain("explorer");
    });

    it("returns error for missing rationale", async () => {
      const deps = makeDeps();
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      const result = await tool.execute({ persona: "explorer", prompt: "do stuff" }, ctx);
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("rationale");
      expect(result.content).toContain("30");
    });

    it("returns error for too-short rationale", async () => {
      const deps = makeDeps();
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      const result = await tool.execute({ persona: "explorer", rationale: "too short", prompt: "do stuff" }, ctx);
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("rationale");
    });

  it("rejects forked history for a persona that requires isolated dispatch", async () => {
    const deps = makeDeps();
    const registry = new Map(deps.agentRegistry);
    const explorer = registry.get("explorer");
    if (!explorer || explorer.kind !== "persona") throw new Error("explorer persona fixture missing");
    registry.set("ship", { ...explorer, name: "ship", role: "ship", allowFork: false });
    const tool = createSubagentDispatch({ ...deps, agentRegistry: registry });

    const result = await tool.execute(
      { persona: "ship", rationale: TEST_RATIONALE, prompt: "publish", fork: true },
      makeContext(),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("subagent failed due to the following issue:");
    expect(result.content).toContain("Subagent 'ship' does not accept forked conversation history. Send a self-contained prompt instead.");
  });

  it("refuses a dispatch the selection disabled, before model resolution or runner construction", async () => {
    let resolvedRoles = false;
    const deps = makeDeps({
      resolveRoles: async () => { resolvedRoles = true; return new Map(); },
      createRunner: () => { throw new Error("runner construction must not be reached"); },
    });
    const capabilityAccess = makeCapabilityAccess({
      admit: () => refusedAdmission("dispatching a subagent is unavailable: subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml"),
    });
    const tool = createSubagentDispatch(deps);

    const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" }, makeContext({ capabilityAccess }));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml");
    expect(capabilityAccess.requests).toEqual([{ operation: "the subagent tool", required: ["subagents"] }]);
    expect(resolvedRoles).toBe(false);
    expect(deps.backgroundTasks.activeSubagentCount()).toBe(0);
  });

  it("rejects an invalid fork source before child publication or runner construction", async () => {
    let resolvedRoles = false;
    const deps = makeDeps({
      resolveRoles: async () => { resolvedRoles = true; return new Map(); },
      createChildConversation: () => { throw new Error("child conversation must not be created"); },
      createRunner: () => { throw new Error("runner construction must not be reached"); },
    });
    const tool = createSubagentDispatch(deps);

    const result = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff", fork: true },
      makeContext({ snapshotConversation: async () => { throw new Error("invalid retained history"); } }),
    );

    expect(result).toEqual({
      content: "Fork source could not be captured: invalid retained history",
      outcome: "error",
    });
    expect(resolvedRoles).toBe(false);
    expect(deps.backgroundTasks.activeSubagentCount()).toBe(0);
  });

  it("dispatches on the root operation's grant without admitting a second time", async () => {
    const capabilityAccess = makeCapabilityAccess({ grant: grantOf(["subagents"]) });
    const runnerCalls: string[] = [];
    const deps = makeDeps({
      createRunner: (options) => {
        runnerCalls.push(String(options.model));
        return { send: () => {}, end: () => {}, abort: () => {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" as const } }) };
      },
    });
    const tool = createSubagentDispatch(deps);

    const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" }, makeContext({ capabilityAccess }));

    expect(result.outcome).toBe("ok");
    expect(capabilityAccess.requests).toEqual([]);
    expect(runnerCalls).toEqual(["claude-sonnet-4-6"]);
  });

  it("dispatches a nested subagent after Subagents was disabled under the admitted operation", async () => {
    // The grant authorizes Subagents; nothing is selected any more. The
    // dispatch continues, and admits nothing.
    const capabilityAccess = makeCapabilityAccess({ grant: grantOf([]) });
    const deps = makeDeps({
      createRunner: () => ({ send: () => {}, end: () => {}, abort: () => {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" as const } }) }),
    });
    const tool = createSubagentDispatch(deps);

    const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" }, makeContext({ capabilityAccess }));

    expect(result.outcome).toBe("ok");
    expect(capabilityAccess.requests).toEqual([]);
  });

  it("refuses a dispatch with no capability boundary at all, before model resolution or runner construction", async () => {
    let resolvedRoles = false;
    const deps = makeDeps({
      resolveRoles: async () => { resolvedRoles = true; return new Map(); },
      createRunner: () => { throw new Error("runner construction must not be reached"); },
    });
    const tool = createSubagentDispatch(deps);

    const result = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" },
      makeContext({ capabilityAccess: undefined }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("holds no capability policy");
    expect(resolvedRoles).toBe(false);
    expect(deps.backgroundTasks.activeSubagentCount()).toBe(0);
  });

  it("forwards the bounded boundary it was admitted on into the child runner", async () => {
    const capabilityAccess = makeCapabilityAccess({ grant: grantOf(["subagents"]) });
    const childAccess: Array<CapabilityAccess | undefined> = [];
    const deps = makeDeps({
      createRunner: (options) => {
        childAccess.push(options.capabilityAccess);
        return { send: () => {}, end: () => {}, abort: () => {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" as const } }) };
      },
    });
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "do stuff" }, makeContext({ capabilityAccess }));

    expect(childAccess).toHaveLength(1);
    expect(childAccess[0]?.grant).toEqual(grantOf(["subagents"]));
    expect(childAccess[0]?.available("subagents")).toBe(true);
    // Evidence of the parent's selection is not authority: the child holds only
    // what the grant authorizes.
    expect(childAccess[0]?.available("learning")).toBe(false);
  });
});
