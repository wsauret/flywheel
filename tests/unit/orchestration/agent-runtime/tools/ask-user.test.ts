import { describe, expect, it } from "bun:test";

import { OutputProjector } from "../../../../../src/infra/output/output-projector.js";
import type { QuestionEntry } from "../../../../../src/infra/output-blocks.js";
import type { AskUserController } from "../../../../../src/orchestration/runner/ask-user-controller.js";
import type { ResolveWorkflowLaunchTarget } from "../../../../../src/orchestration/workflow-host/launch-origin.js";
import { answeredAskUserResult, createAskUserTool } from "../../../../../src/orchestration/agent-runtime/tools/ask-user.js";
import { normalizeAskUserInput } from "../../../../../src/infra/tools/displays/ask-user.js";
import type { RuntimeTool, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { askUserModule } from "../../../../../src/orchestration/modules/ask-user.js";
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import type { AgentInputAnswer } from "../../../../../src/protocol/question-protocol-types.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { SessionFact, SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { asRecord, isRecord } from "../../../../../src/infra/record.js";
import { promptCapabilities } from "../../../../helpers/prompt-capabilities.js";

/** A session writer that stores each fact it records, appending it to `recorded`. */
function recordingWriter(recorded: SessionFact[] = []): SessionFactWriter {
  return {
    record: async (fact) => {
      recorded.push(fact);
      return { aggregateId: "session:s1", sessionId: "s1", id: "event-1", position: 1, seq: 0, timestamp: 1, ...fact };
    },
    recordBatch: async () => { throw new Error("ask_user records one fact at a time"); },
    recordGuarded: async () => { throw new Error("ask_user records no guarded fact"); },
    transaction: async (fn) => { fn(); },
    dispose: () => {},
  };
}

function makeContext(toolUseId = "tool_question"): ToolContext {
  return {
    executionCwd: "/scratch",
    projectRoot: "/scratch",
    userDataRoot: "/scratch/.test-account",
    artifactScopeId: "conversation-1",
    retrievalSessionId: "conversation-1",
    toolUseId,
    sessionId: "conversation-1",
    conversationId: "conversation-1",
    sessionEventWriter: recordingWriter(),
  };
}

describe("ask_user tool", () => {
  it("tells agents to discuss in prose and use the decision UI only once the discussion settles", () => {
    const controller: AskUserController = {
      ask: async () => { throw new Error("unused in this test"); },
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };
    const tool = createAskUserTool(controller, {});

    expect(tool.description).toContain("While the user is asking questions or discussing, reply in prose");
    expect(tool.description).not.toContain("the next step is ambiguous");
    expect(tool.description).toContain("Before you ask, start all work that does not depend on the answer");
  });
  it("normalizes a single question with options into a question entry", () => {
    const normalized = normalizeAskUserInput({
      question: "Which mode?",
      options: [{ label: "Fast" }, { label: "Safe", description: "Run the full checks." }],
    });

    expect(normalized).toEqual({
      success: true,
      questions: [
        {
          question: "Which mode?",
          choices: [
            { kind: "option", choiceId: "choice-1", label: "Fast" },
            { kind: "option", choiceId: "choice-2", label: "Safe", description: "Run the full checks." },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: false,
        },
      ],
    });
  });

  it("renders lead context and a stable provisional row until the controller pushes the question", () => {
    const projector = new OutputProjector({ executionCwd: "/scratch" });
    projector.apply({
      type: "tool-use", toolUseId: "tool_question", name: "ask_user", timestamp: 123,
      input: { question: "Which mode?", options: ["Fast"], context: "Pick the run mode." },
      leadingTextId: "assistant-entry:0:lead",
    });
    expect(projector.getBlocks()).toHaveLength(2);
    expect(projector.getBlocks()[0]).toMatchObject({ kind: "text", id: "assistant-entry:0:lead", content: "Pick the run mode." });
    expect(projector.getBlocks()[1]).toMatchObject({ kind: "tool", id: "tool_question", status: "streaming" });
    projector.apply({
      type: "push-question", toolUseId: "tool_question", timestamp: 124,
      questions: [{ question: "Which mode?", choices: [{ kind: "option", label: "Fast" }], multiSelect: false }],
    });
    expect(projector.getBlocks()).toHaveLength(2);
    expect(projector.getBlocks()[1]).toMatchObject({ kind: "question", toolUseId: "tool_question" });
  });

  it("lifts (Recommended) suffix into a flag and accepts an explicit recommended bool", () => {
    const normalized = normalizeAskUserInput({
      question: "Pick one",
      options: ["Manual", "Auto (Recommended)", { label: "Hybrid", recommended: true }],
    });

    expect(normalized.success && normalized.questions[0]?.choices).toEqual([
      { kind: "option", choiceId: "choice-1", label: "Manual" },
      { kind: "option", choiceId: "choice-2", label: "Auto", recommended: true },
      { kind: "option", choiceId: "choice-3", label: "Hybrid", recommended: true },
      { kind: "freeform", label: "Other" },
    ]);
  });

  it("elides an over-long header instead of rejecting the call", () => {
    const normalized = normalizeAskUserInput({
      questions: [
        { question: "Route?", header: "Implementation", options: [{ label: "A" }] },
        { question: "Keep?", header: "Layout", options: [{ label: "B" }] },
      ],
    });

    expect(normalized.success && normalized.questions[0]?.header).toBe("Implementat\u2026");
    expect(normalized.success && normalized.questions[1]?.header).toBe("Layout");
  });

  it("elides an over-long header without splitting a surrogate pair", () => {
    const normalized = normalizeAskUserInput({
      questions: [{ question: "Pick?", header: "aaaaaaaaaa\u{1F600}bb", options: [{ label: "A" }] }],
    });

    expect(normalized.success && normalized.questions[0]?.header).toBe("aaaaaaaaaa\u{1F600}\u2026");
  });

  it("waits for the controller and returns the selected answers to the model", async () => {
    const controller: AskUserController = {
      ask: async () => ({ kind: "answered", answers: { "Which mode?": { kind: "choice", selections: [{ choiceId: "choice-2" }], text: "Safe" } } }),
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };
    const tool = createAskUserTool(controller, {});

    const result = await executePreparedTool(prepareToolCall({ id: "ask", name: "ask_user", input: {
      question: "Which mode?", context: "Choose a mode.",
      options: ["Fast", "Safe"],
    } }, new Map([[tool.name, tool]]), { ok: true }), makeContext());

    expect(result).toEqual({
      content: "Note: string options were read as option labels.\nUser answered:\n- Which mode?: Safe",
      outcome: "ok",
    });
  });

  it("marks each question a skip left as cancelled beside the answers the user gave", async () => {
    const controller: AskUserController = {
      ask: async () => ({ kind: "answered", answers: { "Option?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "A" } } }),
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };
    const tool = createAskUserTool(controller, {});

    const result = await executePreparedTool(prepareToolCall({ id: "ask-many", name: "ask_user", input: {
      context: "Two choices.",
      questions: [
        { question: "Option?", options: ["A", "B"] },
        { question: "Filename?", options: ["one.txt", "two.txt"] },
      ],
    } }, new Map([[tool.name, tool]]), { ok: true }), makeContext());

    expect(result).toEqual({
      content: "Note: string options were read as option labels.\nUser answered:\n- Option?: A\n- Filename?: (cancelled by the user)",
      outcome: "ok",
    });
  });

  it("returns a cancelled outcome when the user cancels the dock", async () => {
    const controller: AskUserController = {
      ask: async () => ({ kind: "cancelled" }),
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };
    const tool = createAskUserTool(controller, {});

    const result = await tool.execute({
      question: "Continue?",
      options: [{ label: "Yes" }],
    }, makeContext());

    expect(result).toEqual({
      content: "User cancelled the question.",
      outcome: "cancelled",
    });
  });

  it("rejects malformed input before waiting for user input", async () => {
    let asked = false;
    const controller: AskUserController = {
      ask: async () => {
        asked = true;
        return { kind: "cancelled" };
      },
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };
    const tool = createAskUserTool(controller, {});

    const result = await tool.execute({ question: "Missing options" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.content).toBe("Provide either questions[] or question plus options.");
    expect(asked).toBe(false);
  });

  describe("visible-text guard", () => {
    function makeController(onAsk?: () => void): AskUserController {
      return {
        ask: async () => {
          onAsk?.();
          return { kind: "answered", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "choice-1" }], text: "Yes" } } };
        },
        answerQuestion: () => {},
        cancelQuestion: () => {},
        suspendAll: () => false,
      };
    }

    it("rejects a plain question from a turn with no visible text, before recording or asking", async () => {
      let asked = false;
      const tool = createAskUserTool(makeController(() => { asked = true; }), {});
      const recorded: SessionFact[] = [];
      const context = makeContext();
      context.turnHasVisibleText = () => false;
      context.sessionEventWriter = recordingWriter(recorded);

      const result = await tool.execute({ question: "Continue?", options: ["Yes"] }, context);

      expect(result.outcome).toBe("error");
      expect(result.content).toContain("no visible reply text");
      expect(result.content).toContain("`context`");
      expect(asked).toBe(false);
      expect(recorded).toEqual([]);
    });

    it("accepts a plain question carrying a context field when the turn has no visible text", async () => {
      const tool = createAskUserTool(makeController(), {});
      const context = makeContext();
      context.turnHasVisibleText = () => false;

      const result = await tool.execute(
        { question: "Continue?", options: ["Yes"], context: "Two migration paths are possible; the choice changes the rollout." },
        context,
      );

      expect(result).toEqual({ content: "User answered:\n- Continue?: Yes", outcome: "ok" });
    });

    it("rejects a blank context like a missing one", async () => {
      const tool = createAskUserTool(makeController(), {});
      const context = makeContext();
      context.turnHasVisibleText = () => false;

      const result = await tool.execute({ question: "Continue?", options: ["Yes"], context: "   " }, context);

      expect(result.outcome).toBe("error");
    });

    it("rejects the retired global proposal decision without asking", async () => {
      let asked = false;
      const tool = createAskUserTool(makeController(() => { asked = true; }), {});
      const context = makeContext();
      const result = await tool.execute({ decision: { proposal_id: "retired" }, context: "Resolve the global proposal." }, context);
      expect(asked).toBe(false);
      expect(result.outcome).toBe("error");
      expect(JSON.stringify(tool.inputSchema)).not.toContain("proposal_id");
    });

  });

  it("marks a shutdown suspension so the dispatcher does not commit a result", async () => {
    const controller: AskUserController = {
      ask: async () => ({ kind: "suspended" }),
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };

    await expect(createAskUserTool(controller, {}).execute({
      question: "Continue?",
      options: [{ label: "Yes" }],
    }, makeContext())).resolves.toEqual({ content: "", outcome: "interrupted", suspendTurn: true });
  });

  describe("workflow_launch decision", () => {
    const FILE = "/session/scratch/workflows/survey.workflow.yaml";
    const FILE_HASH = "e".repeat(64);
    const resolveTarget: ResolveWorkflowLaunchTarget = async () => ({ source: { kind: "path", path: FILE, definitionSha256: FILE_HASH }, name: "Survey", description: "Survey the routes." });

    function makeController(answer: AgentInputAnswer = {
      kind: "choice",
      selections: [{ choiceId: "approve" }],
      text: "Start the Survey workflow",
    }, onAsk?: (questions: QuestionEntry[]) => void): AskUserController {
      return {
        ask: async (_toolUseId, questions) => {
          onAsk?.(questions);
          return { kind: "answered", answers: { "Launch the Survey workflow?": answer } };
        },
        answerQuestion: () => {},
        cancelQuestion: () => {},
        suspendAll: () => false,
      };
    }

    it("passes the writer-composed decision question to the controller for rendering", async () => {
      let asked: QuestionEntry[] = [];
      const tool = createAskUserTool(makeController(undefined, (questions) => { asked = questions; }), { workflowLaunch: resolveTarget });

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: FILE } } } }, makeContext());

      expect(result.outcome).toBe("ok");
      expect(asked).toHaveLength(1)
      expect(asked[0]?.question).toBe("Launch the Survey workflow?");
      expect(asked[0]?.multiSelect).toBe(false);
      expect(asked[0]?.choices.map((choice) => choice.kind === "option" ? choice.choiceId : choice.kind)).toEqual([
        "approve",
        "inline",
        "freeform",
      ]);
    });

    it("advertises only the source and binds the source-only decision it records", async () => {
      const tool = createAskUserTool(makeController(), { workflowLaunch: resolveTarget });

      const decision = asRecord(asRecord(tool.inputSchema.properties)?.decision);
      const launchField = asRecord(asRecord(decision?.properties)?.workflow_launch);
      if (!launchField || !isRecord(launchField.properties)) throw new Error("the schema advertises no workflow_launch decision");
      expect(Object.keys(launchField.properties)).toEqual(["source"]);
      expect(launchField.required).toEqual(["source"]);

      const recorded: SessionFact[] = [];
      const context = makeContext();
      context.sessionEventWriter = recordingWriter(recorded);

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: FILE } } } }, context);

      expect(result.outcome).toBe("ok");
      expect(result.content).toContain("Confirmation id for this decision: tool_question");
      const fact = recorded[0];
      if (typeof fact !== "object" || fact === null || !("payload" in fact)) throw new Error("expected recorded fact payload");
      const payload = fact.payload;
      if (typeof payload !== "object" || payload === null || !("request" in payload) || !("decision" in payload)) throw new Error("expected question fact");
      const request = payload.request;
      if (!Array.isArray(request)) throw new Error("expected question request array");
      // The question is short and writer-owned: no summary or description bytes.
      expect(request[0]?.question).toBe("Launch the Survey workflow?");
      expect(payload.decision).toEqual({
        kind: "workflow_launch",
        source: { kind: "path", path: FILE, definitionSha256: FILE_HASH },
        question: "Launch the Survey workflow?",
        approve: { choiceId: "approve", label: "Start the Survey workflow" },
        reject: { choiceId: "inline", label: "Do the work inline" },
      });
    });

    it("returns no confirmation id for any non-approval answer", async () => {
      const denials: AgentInputAnswer[] = [
        { kind: "choice", selections: [{ choiceId: "inline" }], text: "Investigate, fix, verify inline" },
        { kind: "choice", selections: [{ choiceId: "direct" }], text: "Fix from current investigation" },
        { kind: "freeform", text: "Use another route" },
      ];

      for (const denial of denials) {
        const tool = createAskUserTool(makeController(denial), { workflowLaunch: resolveTarget });
        const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: FILE } } } }, makeContext());

        expect(result.outcome).toBe("cancelled");
        expect(result.content).toContain("did not approve");
        expect(result.content).not.toContain("Confirmation id");
        expect(result.content).not.toContain("tool_question");
      }
    });

    it("asks about a workflow file by its path and binds the path and the definition hash that the question showed", async () => {
      let asked: QuestionEntry[] = [];
      const recorded: SessionFact[] = [];
      const context = makeContext();
      context.sessionEventWriter = recordingWriter(recorded);
      const tool = createAskUserTool(makeController(undefined, (questions) => { asked = questions; }), { workflowLaunch: resolveTarget });

      await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: "scratch/workflows/survey.workflow.yaml" } } } }, context);

      expect(asked[0]?.choices).toEqual([
        { kind: "option", choiceId: "approve", label: "Start the Survey workflow", description: `Run the workflow file ${FILE}: Survey the routes.` },
        { kind: "option", choiceId: "inline", label: "Do the work inline", description: "Do not start the workflow file, and do the work in this chat." },
        { kind: "freeform", label: "Other" },
      ]);
      expect(recorded[0]).toMatchObject({ payload: { decision: { kind: "workflow_launch", source: { kind: "path", path: FILE, definitionSha256: FILE_HASH } } } });
    });

    it("refuses a source that lacks the field its kind requires before asking anything", async () => {
      let asked = false;
      const tool = createAskUserTool(makeController(undefined, () => { asked = true; }), { workflowLaunch: resolveTarget });

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path" } } } }, makeContext());

      expect(result).toMatchObject({ outcome: "error", content: "workflow_launch requires source with kind 'path' and a path, or kind 'content' and content." });
      expect(asked).toBe(false);
    });

    it("refuses a named source before asking anything", async () => {
      let asked = false;
      const tool = createAskUserTool(makeController(undefined, () => { asked = true; }), { workflowLaunch: resolveTarget });

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "registered", definition_id: "missing" } } } }, makeContext());

      expect(result.outcome).toBe("error");
      expect(result.content).toBe("workflow_launch requires source with kind 'path' and a path, or kind 'content' and content.");
      expect(asked).toBe(false);
    });

    it("gives the agent every located problem of a broken file and how to repair it", async () => {
      const tool = createAskUserTool(makeController(), { workflowLaunch: async () => ({
        error: "The workflow file scratch/workflows/broken.workflow.yaml cannot be approved: the file is not valid.",
        problems: ['scratch/workflows/broken.workflow.yaml: id: Expected a slug'],
        recovery: "Fix the file, and ask again.",
      }) });

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: FILE } } } }, makeContext());

      expect(result).toMatchObject({ outcome: "error", content: [
        "The workflow file scratch/workflows/broken.workflow.yaml cannot be approved: the file is not valid.",
        '- scratch/workflows/broken.workflow.yaml: id: Expected a slug',
        "Fix the file, and ask again.",
      ].join("\n") });
    });

    it("rejects a launch approval from a turn with no visible text and no context", async () => {
      let asked = false;
      const tool = createAskUserTool(makeController(undefined, () => { asked = true; }), { workflowLaunch: resolveTarget });
      const context = makeContext();
      context.turnHasVisibleText = () => false;

      const result = await tool.execute({ decision: { workflow_launch: { source: { kind: "path", path: FILE } } } }, context);

      expect(result.outcome).toBe("error");
      expect(result.content).toContain("no visible reply text");
      expect(asked).toBe(false);
    });

    it("asks a launch approval carrying a context field when the turn has no visible text", async () => {
      const tool = createAskUserTool(makeController(), { workflowLaunch: resolveTarget });
      const context = makeContext();
      context.turnHasVisibleText = () => false;

      const result = await tool.execute({
        decision: { workflow_launch: { source: { kind: "path", path: FILE } } },
        context: "This approval starts the Survey workflow.",
      }, context);

      expect(result.outcome).toBe("ok");
    });

    it("settles a recorded named approval with a retirement notice and no confirmation id", () => {
      const question = "Launch the Debug workflow?";
      const result = answeredAskUserResult([{ question, header: "Workflow", choices: [{ kind: "option", choiceId: "approve", label: "Start" }], multiSelect: false }], { [question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: "Start" } }, { kind: "workflow_launch", source: { kind: "registered", definitionId: "debug" }, question, approve: { choiceId: "approve", label: "Start" }, reject: { choiceId: "inline", label: "Inline" } }, "old-approval");
      expect(result.outcome).toBe("cancelled");
      expect(result.content).toContain("The debug workflow is retired. Flywheel no longer launches it.");
      expect(result.content).not.toContain("Confirmation id");
    });
  });
});

// The kernel identity section says "ask the person" and names no module tool;
// the module that owns the question tool names it, only where it is planned.
describe("ask-user prompt fragment", () => {
  const fragment = askUserModule.contributions.find((contribution) => contribution.domain === "promptFragments");
  const askUser = createAskUserTool({ ask: async () => ({ kind: "cancelled" }), answerQuestion: () => {}, cancelQuestion: () => {}, suspendAll: () => false }, {});
  const render = (tools: ReadonlyMap<string, RuntimeTool>) => {
    if (fragment?.domain !== "promptFragments") throw new Error("The ask-user module contributes no prompt fragment");
    return fragment.value.render({ kernel: testKernelToolDeps({ userDataRoot: "/scratch" }), modules: NO_MODULE_RUNTIMES, tools, memorySnapshot: null, capabilities: promptCapabilities([...tools.values()]) });
  };
  const planned = (...names: string[]) => new Map(names.map((name) => [name, { ...askUser, name }]));

  it("tells a root chat that plans ask_user and can start a child to ask the person with it for a waiting child", () => {
    for (const starter of ["subagent", "workflow"]) {
      expect(render(planned("ask_user", starter))).toContain("ask the person with ask_user, then reply to the child with message_session");
    }
  });

  it("says nothing where ask_user is not planned or no child can start", () => {
    expect(render(new Map())).toBeUndefined();
    expect(render(planned("subagent", "workflow"))).toBeUndefined();
    expect(render(planned("ask_user"))).toBeUndefined();
  });
});
