import { describe, expect, it } from "bun:test";

import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { buildSubagentTask } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import { prepareSubagentTools } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-preparation.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { makeContext as toolContext } from "../tools/_fixtures.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { buildRegistry, createNotificationCapture, makeContext, makeDeps, makeMockRunnerFactory, runnerEffort, TEST_RATIONALE, childTask } from "./_fixtures.js";

/** The first plan of a child of a chat tree: the tools it is advertised
 *  and the ones its grant lets it call. */
function planChildTools(grant: readonly string[], withheld: readonly string[] = []) {
  return planToolExposure({
    kernel: testKernelToolDeps({
      treeHosted: true,
      capabilities: { available: () => true },
      backgroundTasks: createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })).tasks,
    }),
    modules: composeModuleRuntimes([["subagents", { toolDeps: () => makeDeps() }]]),
    granted: { tools: new Set(grant), ambient: grant.length > 0, withheld: new Set(withheld) },
  });
}

describe("subagent tool — execute runner construction", () => {
    it("constructs runner with correct options", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "Found the answer." });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ executionCwd: "/test/cwd", toolUseId: "tc_123" });

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find the config" }, ctx);

      expect(calls.length).toBe(1);
      const opts = calls[0]!.options;
      expect(opts.executionCwd).toBe("/test/cwd");
      // The refactor gap this guards: a child without the parent's module
      // selection dies at its first model request with "requires a capability
      // module snapshot".
      expect(opts.moduleSelection).toBe(deps.moduleSelection);
      expect(opts.maxLLMCalls).toBe(30);
      expect(opts.purpose.kind === "subagent" ? opts.purpose.parentToolUseId : undefined).toBe("tc_123");
      expect(childTask(opts)).toContain("You are a focused codebase investigator.");
      expect(childTask(opts)).toContain("# Delegated Subtask");
      expect(childTask(opts)).toContain("handoff");
      // A same-directory child loads its own chain at its start (PI-AGENT-037).
      expect(opts.agentsMd).toBeUndefined();
      expect(opts.toolGrant).toEqual(["read", "search", "list", "bash", "code", "web", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
      expect(opts.purpose.kind).toBe("subagent");
      if (opts.conversation.kind !== "durable-tree") throw new Error("Expected durable child conversation");
      expect(opts.conversation.sessionId).not.toBe(deps.sessionId);
      expect(opts.conversation.providerSessionKey).not.toBe(deps.providerSessionKey);
      if (opts.purpose.kind !== "subagent") throw new Error("Expected subagent purpose");
      expect(opts.purpose.renderAs).toBe("subagent");
      expect(opts.toolGrant).not.toContain("write");
      expect(opts.runtimeSurfaces?.handoff?.onContent).toBeFunction();
      expect(opts.runtimeSurfaces?.handoff?.schema).toBeDefined();

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("resolves an explicit cwd against the parent execution directory, where the child loads its own instructions", async () => {
      const parentCwd = mkdtempSync(path.join(os.tmpdir(), "subagent-parent-"));
      const childCwd = mkdtempSync(path.join(parentCwd, "child-"));
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const tool = createSubagentDispatch(makeDeps({ createRunner: factory }));

      await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config", cwd: path.basename(childCwd) },
        makeContext({ executionCwd: parentCwd }),
      );

      expect(calls[0]?.options.executionCwd).toBe(realpathSync(childCwd));
      expect(calls[0]?.options.agentsMd).toBeUndefined();
      rmSync(parentCwd, { recursive: true, force: true });
    });

    it("rejects an invalid cwd before runner creation", async () => {
      const parentCwd = mkdtempSync(path.join(os.tmpdir(), "subagent-parent-"));
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const tool = createSubagentDispatch(makeDeps({ createRunner: factory }));

      const result = await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config", cwd: "missing" },
        makeContext({ executionCwd: parentCwd }),
      );

      expect(result.outcome).toBe("error");
      expect(result.content).toContain("does not exist");
      expect(calls).toEqual([]);
      rmSync(parentCwd, { recursive: true, force: true });
    });

    it("runs a subagent in an explicit linked-worktree cwd without any skill loaded first", async () => {
      const parentCwd = mkdtempSync(path.join(os.tmpdir(), "subagent-worktree-parent-"));
      const childCwd = path.join(parentCwd, "linked");
      const gitDir = path.join(parentCwd, "git", "worktrees", "linked");
      mkdirSync(childCwd, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(path.join(childCwd, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(path.join(gitDir, "commondir"), "../..\n");
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const tool = createSubagentDispatch(makeDeps({ createRunner: factory }));
      const input = { persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config", cwd: "linked" };

      const result = await tool.execute(input, makeContext({ executionCwd: parentCwd }));
      expect(result.outcome).not.toBe("error");
      expect(calls[0]?.options.executionCwd).toBe(realpathSync(childCwd));
      rmSync(parentCwd, { recursive: true, force: true });
    });

    it("does not pass a parent notice sink to the child runner", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const deps = { ...makeDeps({ createRunner: factory }), onNotice: () => {} };
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find the config" }, makeContext());

      expect(calls[0]?.options.onNotice).toBeUndefined();
    });

    it("advertises a general child and a persona child of one parent the same tools, and narrows only their grants", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const agentRegistry = buildRegistry();
      agentRegistry.set("general", { kind: "general", name: "general", description: "Clone of the dispatching agent.", maxTurns: 100 });
      const tool = createSubagentDispatch(makeDeps({ agentRegistry, createRunner: factory }));
      const ctx = makeContext({ availableTools: new Set(["read", "search", "list", "bash", "edit", "write", "handoff"]) });
      await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "do the task" }, ctx);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, ctx);

      const plans = await Promise.all(calls.map(({ options }) => {
        expect(options.toolNames).toBeUndefined();
        return planChildTools(options.toolGrant ?? []);
      }));
      const [general, persona] = plans.map((plan) => ({ advertised: [...plan.tools.keys()], usable: plan.usable }));
      expect(general?.advertised).toEqual(persona?.advertised);
      expect(general?.advertised).toEqual(expect.arrayContaining(["edit", "subagent", "process"]));
      expect(general?.usable.has("edit")).toBe(true);
      expect(persona?.usable.has("edit")).toBe(false);
    });

    it("advertises the dispatch and process tools to the deepest child and refuses their calls", async () => {
      const agentRegistry = buildRegistry();
      const worker = { kind: "persona", name: "worker", description: "Worker.", role: "implementer", tools: ["read"], maxTurns: 5, systemPrompt: "Work.", subagentRoles: ["explorer"] } as const;
      agentRegistry.set("worker", worker);
      const deps = makeDeps({ agentRegistry });
      const prepared = prepareSubagentTools({ agent: worker, context: makeContext(), deps, childDepth: 3 });
      if (!prepared.ok) throw new Error(prepared.error.content);

      const plan = await planChildTools(prepared.toolNames, prepared.withheldTools);
      for (const name of ["subagent", "process"]) {
        expect([plan.tools.has(name), plan.usable.has(name)], name).toEqual([true, false]);
        const refusal = await plan.tools.get(name)!.execute({}, toolContext());
        expect(refusal).toMatchObject({ outcome: "error" });
        expect(refusal.content).toContain(`Do not call ${name} again`);
      }
      // A child that can still dispatch keeps process callable.
      const shallow = prepareSubagentTools({ agent: worker, context: makeContext(), deps, childDepth: 2 });
      if (!shallow.ok) throw new Error(shallow.error.content);
      expect((await planChildTools(shallow.toolNames, shallow.withheldTools)).usable.has("process")).toBe(true);
    });

    it("discloses the dispatched agent's turn budget", () => {
      const instructions = buildSubagentTask("You are a worker.", ["read", "handoff"], 42);
      expect(instructions).toContain("at most 42 turns");
    });

    it("keeps report handoffs complete and implementation handoffs concise", () => {
      const instructions = buildSubagentTask("You are a worker.", ["read", "handoff"], 30);
      expect(instructions).toContain("For exploration, analysis, and review assignments, the report is the deliverable");
      expect(instructions).toContain("For implementation assignments, submit a concise completion record");
      expect(instructions).toContain("Do not paste command output or replay the work log");
      expect(instructions).not.toContain("a rich one produces a long handoff");
    });

    it("tells the child to message its parent when a choice its tools cannot settle stops the work, and names no question tool", () => {
      const instructions = buildSubagentTask("You are a worker.", ["read", "handoff", "message_session"], 30);
      expect(instructions).toContain("message your parent with message_session and wait for its reply");
      expect(instructions).not.toContain("ask_user");
      expect(instructions).not.toContain("If truly blocked");
    });

    it("includes git discipline for every file-mutating capability, adjacent to turn economy, and omits it for read-only sets", () => {
      for (const mutatingTool of ["write", "edit"]) {
        const mutating = buildSubagentTask("You are a worker.", ["read", mutatingTool, "handoff"], 30);
        expect(mutating).toContain("## Git Discipline");
        expect(mutating).toContain("track the files you touch yourself");
        expect(mutating.indexOf("## Git Discipline")).toBeGreaterThan(mutating.indexOf("## Turn Economy"));
        expect(mutating.indexOf("## Git Discipline")).toBeLessThan(mutating.indexOf("## Handoff"));
      }

      const readOnly = buildSubagentTask("You are a reviewer.", ["read", "search", "list", "bash", "handoff"], 30);
      expect(readOnly).not.toContain("## Git Discipline");
    });

    it("sends the prompt verbatim to the runner", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);

      const sentPrompt = Promise.withResolvers<string>();
      const wrappedFactory: typeof factory = (opts) => {
        const runner = factory(opts);
        const origSend = runner.send.bind(runner);
        return {
          ...runner,
          send: (text: string) => {
            sentPrompt.resolve(text);
            origSend(text);
          },
        };
      };

      const deps = makeDeps({ sessionDir, createRunner: wrappedFactory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find the config" }, ctx);
      expect(await sentPrompt.promise).toBe("find the config");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("delivers a captured child handoff to the parent notification without a file", async () => {
      const handoff = { summary: "done", files_modified: ["src/app.ts"] };
      const { factory } = makeMockRunnerFactory({ capturedHandoff: handoff });
      const notification = createNotificationCapture();
      const deps = makeDeps({
        backgroundTasks: notification.backgroundTasks,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, makeContext());
      await notification.next;

      expect(notification.read()).toContain(JSON.stringify(handoff, null, 2));
      expect(notification.read()).toContain("<status>completed</status>");
    });

    it("notification sent with fallback message when no text output", async () => {
      const { factory } = makeMockRunnerFactory();
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, ctx);
      await notification.next;

      expect(notification.read()).toContain("<status>failed</status>");
      expect(notification.read()).toContain("completed without producing text output");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("carries an unlisted persona role into request-time resolution without a preview", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("adhoc", {
        kind: "persona",
        name: "adhoc",
        description: "Temporary custom agent.",
        role: "adhoc",
        tools: ["read"],
        maxTurns: 10,
        systemPrompt: "You are a temporary custom agent.",
      });
      const deps = makeDeps({
        agentRegistry,
        resolveRoles: async () => new Map(),
        sessionDir,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      const result = await tool.execute({ persona: "adhoc", rationale: TEST_RATIONALE, prompt: "find stuff", tier: "cheap" }, ctx);

      expect(result.outcome).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.model).toBeUndefined();
      expect(await calls[0]?.options.requestSelection?.(new Map())).toEqual({ roleId: "adhoc" });

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("role override for the agent's role is used", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "high" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, ctx);

      expect(calls[0]?.options.model).toBe("claude-sonnet-4-6");
      expect(await runnerEffort(calls[0]?.options)).toBe("high");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent receives assistant events with parent_tool_use_id at the top level", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        onRenderEvent: (event) => renderedEvents.push(event),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ toolUseId: "tc_parent_456" });

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, ctx);
      await notification.next;

      const assistantEvents = renderedEvents.filter(e => e.type === "model.assistant_message.recorded");
      expect(assistantEvents.length).toBeGreaterThan(0);
      for (const evt of assistantEvents) {
        expect(evt.data.parent_tool_use_id).toBe("tc_parent_456");
      }

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent never receives result events", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, ctx);

      const resultEvents = renderedEvents.filter(e => e.type === "model.turn.completed");
      expect(resultEvents.length).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("onRenderEvent never receives content_block_delta events", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);

      // Wrap factory to inject a content_block_delta event alongside the expected ones.
      const wrappedFactory: typeof factory = (opts) => {
        const runner = factory(opts);
        const origSend = runner.send.bind(runner);
        return {
          ...runner,
          send: (text: string) => {
            opts.onEvent(createRuntimeEvent("model.content.delta", {
              type: "model.content.delta",
              delta: { type: "text_delta", text: "delta" },
              ...(opts.purpose.kind === "subagent" ? { parent_tool_use_id: opts.purpose.parentToolUseId } : {}),
            }));
            origSend(text);
          },
        };
      };

      const deps = makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        createRunner: wrappedFactory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, ctx);

      const deltaEvents = renderedEvents.filter(e => e.type === "model.content.delta");
      expect(deltaEvents.length).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("leaf personas with Bash get a background owner and an empty dispatch roster, so their tools match a step's", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, makeContext());

      const opts = calls[0]!.options;
      expect(opts.agentRegistry).toBe(deps.agentRegistry);
      expect([...(opts.allowedSubagentTypes ?? ["unscoped"])]).toEqual([]);
      expect(opts.toolGrant).not.toContain("subagent");
      expect(opts.toolNames).toBeUndefined();
      expect(opts.childSlots).toBe(deps.childSlots);
      expect(opts.runtimeSurfaces?.background?.tasks.kind).toBe("workflow");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("a persona with subagentRoles gets the registry scoped to those roles plus subagent/background tools", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("worker", {
        kind: "persona",
        name: "worker",
        description: "Implementation worker with scout access.",
        role: "implementer",
        tools: ["read", "edit"],
        maxTurns: 50,
        systemPrompt: "You are a worker.",
        subagentRoles: ["explorer"],
      });
      const deps = makeDeps({ agentRegistry, sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "worker", rationale: TEST_RATIONALE, prompt: "build it" }, makeContext());

      const opts = calls[0]!.options;
      expect(opts.agentRegistry).toBe(agentRegistry);
      expect([...(opts.allowedSubagentTypes ?? [])]).toEqual(["explorer"]);
      expect(opts.toolGrant).toContain("subagent");
      expect(opts.toolGrant).toContain("process");
      expect(opts.runtimeSurfaces?.background?.tasks.kind).toBe("workflow");
      expect(opts.childSlots).toBe(deps.childSlots);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("a self-grant never includes the dispatched persona itself", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("worker", {
        kind: "persona",
        name: "worker",
        description: "Worker granting its own role.",
        role: "implementer",
        tools: ["read", "edit"],
        maxTurns: 50,
        systemPrompt: "You are a worker.",
        subagentRoles: ["implementer"],
      });
      const deps = makeDeps({ agentRegistry, sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "worker", rationale: TEST_RATIONALE, prompt: "build it" }, makeContext());

      // The fixture registry's "implementer" shares the granted role and is
      // included; the dispatched "worker" itself is excluded.
      expect([...(calls[0]!.options.allowedSubagentTypes ?? [])]).toEqual(["implementer"]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("the general agent's grant resolves reviewer roles from the live registry", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("reviewer-code-quality", {
        kind: "persona",
        name: "reviewer-code-quality",
        description: "Reviews code quality.",
        role: "reviewer",
        tools: ["read", "search", "list"],
        maxTurns: 30,
        systemPrompt: "You are a reviewer.",
      });
      agentRegistry.set("general", {
        kind: "general",
        name: "general",
        description: "Clone of the dispatching agent.",
        maxTurns: 100,
        subagentRoles: ["explorer", "reviewer"],
      });
      const deps = makeDeps({ agentRegistry, sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ availableTools: new Set(["read", "search", "subagent", "process", "handoff"]) });

      await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "do the task" }, ctx);

      const opts = calls[0]!.options;
      expect(new Set(opts.allowedSubagentTypes)).toEqual(new Set(["explorer", "reviewer-code-quality"]));
      expect(opts.toolGrant).toContain("subagent");
      expect(opts.toolGrant).not.toContain("general");

      rmSync(sessionDir, { recursive: true, force: true });
    });

});
