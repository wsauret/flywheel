import { describe, expect, it } from "bun:test";
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js";
import { assembleAgentPrompt } from "../../../../src/workflows/context-bundle/prompt-assembly.js";
import { renderWorkflowRequestSection } from "../../../../src/workflows/context-bundle/workflow-request.js";
import type { AttemptRow } from "../../../../src/workflows/view/types.js";
import type { CapabilityCheck } from "../../../../src/infra/capability-text.js";
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js";
import { testResolvedAgent } from "../../../helpers/skill-fixtures.js";
import { attempt, binding, committedControl, completed, deps, run, skills, workSkill } from "./attempt-runner-test-support.js";
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js";

/** The check of an agent that may call every tool except bash. */
const withoutBash: CapabilityCheck = (term) => term !== "bash";

describe("attempt runner prompt parity", () => {
  it("assembles an inline brief through the canonical prompt builder", async () => {
    let seenAttempt: AttemptRow | undefined;
    let seenPrompt: { userPrompt: string; task: string } | undefined;
    const outcome = await run({
      worker: async (row, brief) => {
        seenAttempt = row;
        seenPrompt = await brief(EVERY_CAPABILITY);
        return completed();
      },
    });
    const expectedAttempt: AttemptRow = {
      id: attempt.attemptId,
      definitionId: attempt.definitionId,
      briefId: workSkill.id,
      workflowDefinitionId: attempt.workflowDefinitionId,
      name: workSkill.name,
      description: "Retry 2: prior: Fix the failing assertion.",
      status: "running",
      writes: ["artifact"],
      resumeRevertCount: 0,
      item: attempt.item,
      lastConversationId: "conversation-1",
    };
    const expected = assembleAgentPrompt({
      capabilities: () => true,
      attempt: expectedAttempt,
      agent: binding,
      contextBundle: renderWorkflowRequestSection({ original: "Implement secure login.", addenda: [] }),
      skills,
    });

    expect(seenAttempt).toEqual(expectedAttempt);
    expect(seenPrompt).toEqual({ userPrompt: expected.userPrompt, task: expected.task });
    expect(outcome).toMatchObject({ kind: "success" });
  });

  it("carries inherited intent separately from one accumulated context snapshot per attempt", async () => {
    let contextReads = 0;
    let inheritedIntent: string | undefined;
    let userPrompt: string | undefined;
    const accumulator = createContextAccumulator();
    accumulator.seedInput({ workflowDefinitionId: "workflow", userRequest: "Implement secure login.", inheritedIntent: "Preserve exact approved intent.", timestamp: 1 });

    await run({
      worker: async (_row, brief, _signal, _conversationId, _onToolUses, intent) => {
        inheritedIntent = intent;
        ({ userPrompt } = await brief(EVERY_CAPABILITY));
        return completed();
      },
      context: {
        getContext: async () => {
          contextReads += 1;
          return accumulator.getContext();
        },
      },
    });

    expect(contextReads).toBe(1);
    expect(inheritedIntent).toBe("Preserve exact approved intent.");
    expect(userPrompt).not.toContain("Preserve exact approved intent.");
  });

  it("gives an overflow continuation the latest checkpoint and the file edits of its earlier conversations", async () => {
    let userPrompt = "";
    const checkpointReads: string[] = [];
    const checkpointChecks: CapabilityCheck[] = [];
    const evidenceReads: (readonly string[])[] = [];
    const continuation = { ...attempt, provenance: { _tag: "continuation", reason: "overflow", sourceConversationId: null, chargeAttemptId: "attempt-0" } } as const;
    const runner = createAttemptExecutor(deps({
      worker: async (_row, brief) => { ({ userPrompt } = await brief(withoutBash)); return completed(); },
      earlierCheckpoint: async (conversationId, capabilities) => { checkpointReads.push(conversationId); checkpointChecks.push(capabilities); return "# Next step\n\nFinish the migration."; },
      buildArtifactContext: async (writers) => { evidenceReads.push(...writers.map(({ conversationIds }) => conversationIds)); return "## File Edits by Agent \"Work\"\n\nedits"; },
    }));
    await runner.run(continuation, {
      workflowSessionId: "workflow-session", conversationId: "conversation-1", signal: new AbortController().signal, committedControl,
      conversationsOf: async (attemptId) => attemptId === continuation.attemptId ? ["first", "second", "conversation-1"] : [],
    });

    expect(checkpointReads).toEqual(["second"]);
    // The earlier checkpoint renders for the agent that reads it.
    expect(checkpointChecks).toEqual([withoutBash]);
    expect(evidenceReads).toEqual([["first", "second"]]);
    expect(userPrompt).toEndWith([
      "## Your Earlier Attempt",
      "An earlier attempt of this agent outgrew its context window. You continue its work in a new conversation. Its latest checkpoint and the file edits that it recorded follow. Do not repeat the work that it finished.",
      "# Next step\n\nFinish the migration.",
      "## File Edits by Agent \"Work\"\n\nedits",
    ].join("\n\n"));

    await run({ worker: async (_row, brief) => { ({ userPrompt } = await brief(EVERY_CAPABILITY)); return completed(); }, earlierCheckpoint: async () => { throw new Error("only a continuation reads a checkpoint"); } });
    expect(userPrompt).not.toContain("## Your Earlier Attempt");
  });

  it("renders the postamble for the agent's own check", async () => {
    let task = "";
    await run({ worker: async (_row, brief) => { ({ task } = await brief(withoutBash)); return completed(); } });
    expect(task.endsWith(binding.output.instructions(false))).toBe(true);
    await run({ worker: async (_row, brief) => { ({ task } = await brief(EVERY_CAPABILITY)); return completed(); } });
    expect(task.endsWith(binding.output.instructions(true))).toBe(true);
  });

  it("fails an agent that must cite commands, without bash, when its brief composes", async () => {
    const citing = testResolvedAgent("work", workSkill, { output: { commands: { min: 1 } } });
    let acquired = false;
    const outcome = await run({
      resolvedAgents: new Map([[citing.definitionId, citing]]),
      worker: async (_row, brief) => { await brief(withoutBash); acquired = true; return completed(); },
    });

    expect(acquired).toBe(false);
    expect(outcome).toMatchObject({ kind: "fatal", reason: 'fatal error - Workflow "workflow" agent "work" needs command evidence. bash is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml.' });
    expect(await run({ resolvedAgents: new Map([[citing.definitionId, citing]]) })).toMatchObject({ kind: "success" });
  });

  it("fails an attempt that names no binding before acquiring a worker", async () => {
    let acquired = false;
    const outcome = await run({
      resolvedAgents: new Map(),
      worker: async () => {
        acquired = true;
        return completed();
      },
    });

    expect(acquired).toBe(false);
    expect(outcome).toMatchObject({ kind: "fatal", reason: `fatal error - attempt names unknown agent record "${attempt.definitionId}"` });
  });
});
