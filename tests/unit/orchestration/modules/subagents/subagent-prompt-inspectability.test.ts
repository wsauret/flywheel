import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import { newTestRunner } from "../../../../helpers/agent-runner.js";
import type {
  LLMClient,
  ModelClient,
  StreamOptions,
} from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { asModelClient, ownHistoryTarget } from "../../agent-runtime/_model-client.js";
import { ContextLengthExceededError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { loadProviderRequestAuditFromEvents } from "../../../../../src/orchestration/session/provider-request-audit-projection.js";
import { reconstructProviderRequestPrompt } from "../../../../../src/orchestration/session/provider-request-audit-reconstruction.js";
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js";
import { loadSubagentRunsFromEvents } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { capabilityAccessHolding } from "../../agent-runtime/tools/_fixtures.js";
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { continuationService, createRoot, createUnstartedChild, heldRunner, subagentChildHarnesses } from "./_subagent-child-fixtures.js";
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js";
import { liveChildRun } from "../../../../../src/orchestration/session/live-session-control.js";
import { createConversationCheckpointOwner, readRecordedInheritedIntent } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { createProjectStateSessionManager, createProjectStateSessionsService } from "../../../../../src/orchestration/app-service/project-state-sessions.js";

// What a dispatched subagent leaves behind must describe what actually
// happened: the launch fact states the task instructions it was given, and the
// provider-request audit states the system prompt the model received. Neither
// may stand in for the other. The child owns a durable conversation
// (ARCH-SESSIONS-010), so its request must refold from durable facts to the exact bytes
// the provider received.

const RATIONALE = "integration fixture: dispatch rationale long enough to pass the 30-char minimum";

const EXPLORER: AgentDefinition = {
  kind: "persona",
  name: "explorer",
  description: "Fast read-only codebase investigation.",
  role: "explorer",
  tools: ["read"],
  maxTurns: 4,
  systemPrompt: "You are a focused codebase investigator.",
};

const createHarness = subagentChildHarnesses();

/** Single-candidate chain over a fake adapter that hands off on its first call
 *  and records every system prompt it was sent. */
function fakeClient(observed: string[]): ModelClient {
  let calls = 0;
  const client: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "claude-test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      observed.push(renderSystemPrompt(options.systemPrompt));
      calls += 1;
      if (calls === 1) {
        yield { kind: "tool_use", toolCall: { id: "handoff-1", name: "handoff", input: { summary: "found it" } } } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
        return;
      }
      yield { kind: "text_delta", text: "done", blockKey: "text" } as const;
      yield { kind: "done", stopReason: "end_turn" } as const;
    },
  };
  return asModelClient(client);
}

describe("dispatched subagent prompt inspectability", () => {
  for (const boundary of ["direct", "state-worker"] as const)
  for (const mode of ["approved", "draft", "fork", "absent"] as const) test(`records the child prompt and ${mode} checkpoint inheritance through ${boundary} publication`, async () => {
    const observedSystemPrompts: string[] = [];
    const harness = createHarness((options) => newTestRunner(options, async () => fakeClient(observedSystemPrompts)), boundary === "direct" ? undefined : (manager) => {
      const service = createProjectStateSessionsService(manager);
      return createProjectStateSessionManager({
        request: async (command) => structuredClone(await service.request(structuredClone(command))),
        subscribe: (listener) => service.subscribe((change) => listener(structuredClone(change))),
      });
    });
    const reconciled = Promise.withResolvers<void>();
    harness.authority.reconcileParentCompletion = (parentSessionId) => {
      void reconcileChildSessionCompletions({
        parentSessionId, reader: harness.reader, writer: harness.writer,
      }).then(() => reconciled.resolve(), reconciled.reject);
    };
    try {
      const conversationId = "subagent-inspect-conversation";
      const sessionId = await harness.manager.createChat({ id: "subagent-inspect", conversationId, name: "subagent-inspect" });
      const checkpoint = createConversationCheckpointOwner(harness.reader, createSessionFactWriter({ sessionId, writer: harness.writer }), { kind: "session", sessionId }, conversationId);
      if (mode !== "absent") {
        await checkpoint.replace("designIntent", { text: "Preserve the exact user intent.", approved: mode !== "draft" });
        await checkpoint.decide({ date: "2026-10-21", words: "Keep every rejected alternative.", replaces: "Keep only the latest decision." });
        await checkpoint.replace("workingNotes", "PRIVATE-PARENT-NOTES");
      }
      const originalCheckpoint = await checkpoint.read();
      writeFileSync(join(harness.projectRoot, "AGENTS.md"), "PROJECT-INSTRUCTIONS-MARKER");
      await harness.tool(sessionId, {
        agentRegistry: new Map([["explorer", EXPLORER]]),
        skills: repoDefinitions().skills(),
        modelFamily: "anthropic",
        parentModel: "claude-test",
        providerSessionKey: sessionId,
        captureRuntimeConfig: testRuntimeConfigCapture,
        moduleSelection: testCapabilityModules,
        resolveRoles: async () => new Map([["explorer", { roleId: "explorer", model: "claude-test", effort: "medium" }]]),
      }).execute(
        { persona: "explorer", rationale: RATIONALE, prompt: "find the config loader", ...(mode === "fork" ? { fork: true } : {}) },
        {
          executionCwd: harness.projectRoot,
          projectRoot: harness.projectRoot,
          artifactScopeId: sessionId,
          toolUseId: "tc-1",
          conversationId,
          capabilityAccess: capabilityAccessHolding(["subagents"]),
          snapshotConversation: async () => [{ kind: "user", content: "Earlier context without the latest checkpoint." }],
        },
      );
      await reconciled.promise;

      // The child session owns both the launch fact and the audit fact.
      const childSessionId = (await harness.manager.read(sessionId))?.childSessionIds?.[0];
      if (childSessionId === undefined) throw new Error("expected the dispatch to publish a child session");
      const childEvents = harness.store.read({ aggregateId: `session:${childSessionId}` });

      // 1. The launch fact reports task instructions, not a system prompt.
      const run = loadSubagentRunsFromEvents(childEvents)[0];
      expect(run?.task).toContain("You are a focused codebase investigator.");
      expect(run?.task).toContain("# Delegated Subtask");
      expect(run?.task).not.toContain("PROJECT-INSTRUCTIONS-MARKER");
      expect(run).not.toHaveProperty("systemPrompt");

      // 2. The audit fact reports the assembled system prompt the model saw.
      //    The task is a turn of the child's conversation, not part of it.
      const sentSystemPrompt = observedSystemPrompts[0];
      expect(sentSystemPrompt).toBeString();
      if (sentSystemPrompt === undefined) throw new Error("expected a captured system prompt");
      expect(sentSystemPrompt).not.toContain("# Delegated Subtask");
      expect(sentSystemPrompt).toContain("PROJECT-INSTRUCTIONS-MARKER");

      const entry = loadProviderRequestAuditFromEvents(childEvents)[0];
      expect(entry?.prompt?.promptKind).toBe("subagent");

      // 3. Reconstruction refolds the child's durable conversation, system
      //    prompt, and tool surface into the exact prompt the provider received.
      const result = await reconstructProviderRequestPrompt({ entry: entry!, store: harness.store, sessionEvents: childEvents });
      if (result.kind !== "reconstructed") throw new Error(`a child conversation is a durable tree, not ${result.reason}`);

      expect(result.systemPrompt).toBe(sentSystemPrompt);
      expect(JSON.stringify(result.messages)).toContain(JSON.stringify(run!.task!).slice(1, -1));
      expect(result.computedSha256).toBe(entry!.prompt!.promptSha256);
      expect(result.verified).toBe(true);
      expect(result.tools.map((t) => t.name)).toContain("read");
      // The inherited intent is standing context in the session tier, so every
      // request, including the first after a reset, carries it; no message does.
      expect(JSON.stringify(result.messages)).not.toContain("# Inherited design intent");
      if (mode === "approved" || mode === "fork") {
        expect(sentSystemPrompt).toContain(`Source session: ${sessionId}\nSource conversation: ${conversationId}`);
        expect(sentSystemPrompt).toMatch(/Checkpoint SHA-256: [0-9a-f]{64}/);
        expect(sentSystemPrompt).toContain("# Design intent (approved)\n\nPreserve the exact user intent.");
        expect(sentSystemPrompt).toContain("## 2026-10-21\n\nKeep every rejected alternative.\n\nReplaces: Keep only the latest decision.");
        expect(sentSystemPrompt).not.toContain("PRIVATE-PARENT-NOTES");
        expect(sentSystemPrompt).not.toContain("# Working notes");
      } else {
        expect(sentSystemPrompt).not.toContain("# Inherited design intent");
        expect(JSON.stringify(result.messages)).not.toContain("Preserve the exact user intent.");
      }
      expect(await checkpoint.read()).toEqual(originalCheckpoint);
    } finally {
      await harness.close();
    }
  });
});

describe("inherited intent below a subagent", () => {
  test.each([
    ["holds no approved intent", false, "Preserve the root intent."],
    ["holds its own approved intent", true, "Preserve the child intent."],
  ] as const)("a grandchild whose parent subagent %s inherits the nearest approved intent", async (_case, childApproved, expected) => {
    const harness = createHarness(heldRunner().createAgent);
    try {
      const root = await createRoot(harness.manager);
      await createConversationCheckpointOwner(harness.reader, createSessionFactWriter({ sessionId: root.sessionId, writer: harness.writer }), { kind: "session", ...root }, root.conversationId)
        .replace("designIntent", { text: "Preserve the root intent.", approved: true });
      const child = await createUnstartedChild(harness.manager, harness.projectRoot, root);
      await createConversationCheckpointOwner(harness.reader, createSessionFactWriter({ sessionId: child.childSessionId, writer: harness.writer }), { kind: "session", sessionId: child.childSessionId }, child.childConversationId)
        .replace("designIntent", { text: "Preserve the child intent.", approved: childApproved });
      const grandchild = await createUnstartedChild(harness.manager, harness.projectRoot, { sessionId: child.childSessionId, conversationId: child.childConversationId });

      const intent = await readRecordedInheritedIntent(harness.reader, grandchild.childSessionId);
      expect(intent).toContain(`# Design intent (approved)\n\n${expected}`);
    } finally {
      await harness.close();
    }
  });
});

describe("dispatched subagent reset", () => {
  test("the opening after a reset restates the launch assignment and the task, and the system tier still carries the inherited intent", async () => {
    const requests: StreamOptions[] = [];
    let calls = 0;
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "claude-test", contextLimit: 100_000, outputLimit: 8_000,
      supportsReasoning: false, toolPresentation: FUNCTION_TOOL_PRESENTATION,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) {
        requests.push(options);
        calls += 1;
        if (calls === 1) throw normalizeProviderAttemptFailure(new ContextLengthExceededError());
        yield { kind: "tool_use", toolCall: { id: "handoff-1", name: "handoff", input: { summary: "found it" } } } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
      },
    };
    const harness = createHarness((options) => newTestRunner(options, async () => asModelClient(client)));
    const reconciled = Promise.withResolvers<void>();
    harness.authority.reconcileParentCompletion = (parentSessionId) => {
      void reconcileChildSessionCompletions({ parentSessionId, reader: harness.reader, writer: harness.writer })
        .then(() => reconciled.resolve(), reconciled.reject);
    };
    try {
      const conversationId = "subagent-reset-conversation";
      const sessionId = await harness.manager.createChat({ id: "subagent-reset", conversationId, name: "subagent-reset" });
      await createConversationCheckpointOwner(harness.reader, createSessionFactWriter({ sessionId, writer: harness.writer }), { kind: "session", sessionId }, conversationId)
        .replace("designIntent", { text: "Preserve the exact user intent.", approved: true });
      await harness.tool(sessionId, {
        agentRegistry: new Map([["explorer", EXPLORER]]), skills: repoDefinitions().skills(), modelFamily: "anthropic", parentModel: "claude-test",
        providerSessionKey: sessionId, captureRuntimeConfig: testRuntimeConfigCapture, moduleSelection: testCapabilityModules,
        resolveRoles: async () => new Map([["explorer", { roleId: "explorer", model: "claude-test", effort: "medium" }]]),
      }).execute(
        { persona: "explorer", rationale: RATIONALE, prompt: "find the config loader" },
        { executionCwd: harness.projectRoot, projectRoot: harness.projectRoot, artifactScopeId: sessionId, toolUseId: "tc-1", conversationId,
          capabilityAccess: capabilityAccessHolding(["subagents"]), snapshotConversation: async () => [] },
      );
      await reconciled.promise;

      const opening = requests[1]?.messages[0];
      if (opening?.kind !== "user" || typeof opening.content !== "string") throw new Error("expected the reset opening");
      expect(opening.content).toContain("# Brief\n\nfind the config loader");
      expect(opening.content).toContain("# Delegated Subtask");
      expect(opening.content).toEndWith("Continue the task from the brief above.");
      expect(renderSystemPrompt(requests[1]!.systemPrompt)).toContain("# Design intent (approved)\n\nPreserve the exact user intent.");
    } finally {
      await harness.close();
    }
  });
});

describe("resumed subagent", () => {
  test("a resumed child keeps its recorded brief for a reset opening and its inherited intent in the system tier", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const root = await createRoot(harness.manager)
    await createConversationCheckpointOwner(harness.reader, createSessionFactWriter({ sessionId: root.sessionId, writer: harness.writer }), { kind: "session", sessionId: root.sessionId }, root.conversationId)
      .replace("designIntent", { text: "Preserve the root intent.", approved: true })
    const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
    const result = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() }).execute({ persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE }, context)
    const child: string = JSON.parse(result.content).session_id
    await liveChildRun(harness.reader, child)?.child.interrupt("person")
    const host = continuationService(harness, runner.createAgent)
    try {
      expect((await host.service.resume(child)).outcome).toBe("ok")
      const resumed = runner.options.at(-1)!
      expect(runner.options).toHaveLength(2)
      expect(await resumed.standingBrief?.()).toEqual(await runner.options[0]!.standingBrief?.())
      expect(await resumed.standingBrief?.()).toContain("Inspect the saved assignment.")
      expect(resumed.purpose).toMatchObject({ kind: "subagent", inheritedIntent: expect.stringContaining("# Design intent (approved)\n\nPreserve the root intent.") })
    } finally { await host.close(); await harness.close() }
  })

});

// Each child loads the instruction files at its own start (PI-AGENT-037).
describe("dispatched subagent instruction chain", () => {
  /** A chat whose dispatches each return the system prompt their child was sent. */
  async function chatDispatcher(harness: ReturnType<typeof createHarness>, observedSystemPrompts: readonly string[], projectRoot: string, id: string) {
    const conversationId = `${id}-conversation`;
    const sessionId = await harness.manager.createChat({ id, conversationId, name: id });
    let dispatches = 0;
    return async (cwd?: string): Promise<string> => {
      const reconciled = Promise.withResolvers<void>();
      harness.authority.reconcileParentCompletion = (parentSessionId) => {
        void reconcileChildSessionCompletions({
          parentSessionId, reader: harness.reader, writer: harness.writer,
        }).then(() => reconciled.resolve(), reconciled.reject);
      };
      dispatches += 1;
      await harness.tool(sessionId, {
        agentRegistry: new Map([["explorer", EXPLORER]]),
        skills: repoDefinitions().skills(),
        modelFamily: "anthropic",
        parentModel: "claude-test",
        providerSessionKey: sessionId,
        captureRuntimeConfig: testRuntimeConfigCapture,
        moduleSelection: testCapabilityModules,
        resolveRoles: async () => new Map([["explorer", { roleId: "explorer", model: "claude-test", effort: "medium" }]]),
      }).execute(
        { persona: "explorer", rationale: RATIONALE, prompt: "find the config loader", ...(cwd ? { cwd } : {}) },
        {
          executionCwd: projectRoot,
          projectRoot,
          artifactScopeId: sessionId,
          toolUseId: `tc-${dispatches}`,
          conversationId,
          capabilityAccess: capabilityAccessHolding(["subagents"]),
          snapshotConversation: async () => [],
        },
      );
      await reconciled.promise;
      return observedSystemPrompts.at(-1) ?? "";
    };
  }

  test("a child in another directory follows the instruction files down to its own directory", async () => {
    const observed: string[] = [];
    const harness = createHarness((options) => newTestRunner(options, async () => fakeClient(observed)));
    try {
      // The CLI publishes canonical directories, and a child's cwd is canonical.
      const projectRoot = realpathSync(harness.projectRoot);
      writeFileSync(join(projectRoot, "AGENTS.md"), "ROOT-RULES");
      mkdirSync(join(projectRoot, "pkg"));
      writeFileSync(join(projectRoot, "pkg", "AGENTS.md"), "PACKAGE-RULES");
      const sentSystemPrompt = await (await chatDispatcher(harness, observed, projectRoot, "subagent-cwd"))("pkg");
      expect({
        root: sentSystemPrompt.includes("## Repository instructions (AGENTS.md)\n\nROOT-RULES"),
        package: sentSystemPrompt.includes("## Repository instructions (pkg/AGENTS.md)\n\nPACKAGE-RULES"),
      }).toEqual({ root: true, package: true });
    } finally {
      await harness.close();
    }
  });

  test("a child in its dispatcher's directory sees an instruction edit made after an earlier child started", async () => {
    const observed: string[] = [];
    const harness = createHarness((options) => newTestRunner(options, async () => fakeClient(observed)));
    try {
      const projectRoot = realpathSync(harness.projectRoot);
      writeFileSync(join(projectRoot, "AGENTS.md"), "OLD-RULES");
      const dispatch = await chatDispatcher(harness, observed, projectRoot, "subagent-edit");
      const first = await dispatch();
      writeFileSync(join(projectRoot, "AGENTS.md"), "NEW-RULES");
      const second = await dispatch();
      expect({
        firstOld: first.includes("OLD-RULES"),
        secondNew: second.includes("NEW-RULES"),
        secondOld: second.includes("OLD-RULES"),
      }).toEqual({ firstOld: true, secondNew: true, secondOld: false });
    } finally {
      await harness.close();
    }
  });
});
