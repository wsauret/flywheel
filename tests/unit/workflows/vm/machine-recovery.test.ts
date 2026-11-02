import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  initializeWorkflow,
  replayWorkflow,
  transitionDecodedWorkflow,
  transitionWorkflow,
} from "../../../../src/workflows/vm/transition.js";
import { compileWorkflowControl, launchGuardrailLimits } from "../../../../src/workflows/vm/compile.js";
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js";
import type { DecodedWorkflowEvent, WorkflowProposalEncoding } from "../../../../src/workflows/vm/events.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { workflowProgress, workflowSummaryText } from "../../../../src/protocol/client/workflow-progress.js";
import { frontendView } from "./_tree-fixtures.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js";
import { acknowledge, runningControl, startPreparedAttempt, success } from "./_machine-semantics-fixtures.js";

describe("workflow machine recovery semantics", () => {
  it.each([
    { hypothesis: null, failedChecks: 0, route: ["verify"], shown: ["Investigate", "Verify"], progress: "round 1 of at most 3 · dry" },
    {
      hypothesis: "Confirmed causal chain.", failedChecks: 1, route: ["fix", "verify", "refix", "verify"],
      shown: ["Investigate", "Fix", "Verify", "Fix · round 2", "Verify · round 2"], progress: "round 2 of at most 3 · dry",
    },
    // The repeat ends on its check: the third verify that still reports a
    // defect is the last agent, and no fix follows it.
    {
      hypothesis: "Confirmed causal chain.", failedChecks: 3, route: ["fix", "verify", "refix", "verify", "refix", "verify"],
      shown: ["Investigate", "Fix", "Verify", "Fix · round 2", "Verify · round 2", "Fix · round 3", "Verify · round 3"], progress: "round 3 of at most 3 · max 3 rounds",
    },
  ])("routes the fixture graph from hypothesis $hypothesis with $failedChecks failed checks", ({ hypothesis, failedChecks, route, shown, progress }) => {
    const definitions = fixtureDefinitions();
    const workflow = workflowIn(definitions.captureRevision(), FIXTURE_WORKFLOW_ID);
    const skills = definitions.skills();
    const compiled = compileWorkflowControl(
      workflow,
      resolveWorkflowAgents(workflow),
      { skills },
    );
    const node = compiled.graph.nodes[0];
    const attempt = compiled.attempts[0];
    if (!node || node.kind !== "agent" || !attempt) throw new Error("The fixture workflow root is missing");
    const running = {
      ...compiled,
      graph: { ...compiled.graph, nodes: [{ ...node, state: { _tag: "running" as const } }, ...compiled.graph.nodes.slice(1)] },
      attempts: [{ ...attempt, state: { _tag: "running" as const }, conversationId: "repair-investigation" }, ...compiled.attempts.slice(1)],
      frontier: [],
      status: "executing" as const,
    };

    let completed = acknowledge(success(replayWorkflow(running), {
      summary: "Decisive investigation result.",
      hypothesis,
      evidence: ["Focused evidence."],
    }, attempt.id));

    let verifications = 0;
    const commands_run = [{ toolUseId: "check", command: "focused check", exitCode: 0, observation: "Fresh observation." }];
    for (const definitionId of route) {
      expect(completed.command).toMatchObject({
        kind: "prepare_attempt",
        attempt: { definitionId },
      });
      if (completed.command.kind !== "prepare_attempt") throw new Error(`${definitionId} was not prepared`);
      const active = startPreparedAttempt(completed);
      const handoff = definitionId !== "verify"
        ? {
            summary: "Fixed the confirmed cause.",
            hypothesis,
            commands_run,
            evidence: ["Fresh RED and GREEN observations."],
            fix_description: "Corrected the confirmed cause.",
          }
        : {
            summary: "Verified the present tree.",
            commands_run,
            evidence: ["Fresh final regression observation."],
            defects: ++verifications <= failedChecks
              ? [{ check: "Original symptom", observation: "The reported defect remains." }]
              : [],
          };
      completed = acknowledge(success(active.state, handoff, completed.command.attempt.attemptId));
    }
    expect(completed.state.context.committed.status).toBe("completed");
    expect(completed.state.context.committed.attempts.filter(({ state }) => state._tag === "completed")).toHaveLength(1 + route.length);
    // Each phase shows the round of the check that it leads to, and the
    // header counts the same rounds.
    const view = frontendView(completed.state.context.committed, resolveWorkflowAgents(workflow));
    expect(view.tree.nodes.flatMap((entry) => entry.kind === "phase" && entry.disposition !== "skipped" ? [`${entry.label}${entry.round === undefined ? "" : ` · round ${entry.round.number}`}`] : [])).toEqual([...shown]);
    expect(workflowSummaryText(workflowProgress(view))).toEndWith(progress);
  });

  it("restarts an attempt that made progress since its last start without end, and pauses one that made none after three restarts", () => {
    const restart = (state: ReturnType<typeof replayWorkflow>, progressed: readonly string[]) =>
      acknowledge(transitionWorkflow(state, { type: "RECOVER", progressed }));
    let progressing = replayWorkflow(runningControl());
    for (let recovery = 1; recovery <= 4; recovery += 1) {
      const recovered = restart(progressing, ["attempt"]);
      expect(recovered.state.context.committed.attempts[0]?.resumeRevertCount).toBe(1);
      progressing = startPreparedAttempt(recovered).state;
    }

    let stalled = replayWorkflow(runningControl());
    for (let recovery = 1; recovery <= 3; recovery += 1) stalled = startPreparedAttempt(restart(stalled, [])).state;
    const capped = transitionWorkflow(stalled, { type: "RECOVER", progressed: [] });
    expect(capped.state.context.pending?.facts.map(({ type }) => type)).toEqual(["attempt.resume_cap_exceeded", "workflow.control.committed"]);
    expect(acknowledge(capped).state.lifecycle).toBe("paused");
  });

  it("recovers only the interrupted frontier and never revives a failed retry ancestor", () => {
    const failed = acknowledge(transitionWorkflow(
      replayWorkflow(runningControl({ retry: { max: 2, stuck: true } })),
      {
        type: "ATTEMPT_FAILED",
        failure: { attemptId: "attempt", kind: "handoff", reason: "retry", conversationId: "ancestor-conversation" },
      },
    ));
    const recovered = acknowledge(transitionWorkflow(failed.state, { type: "RECOVER", progressed: [] }));

    expect(recovered.state.context.committed.attempts[0]).toMatchObject({
      id: "attempt",
      state: { _tag: "failed" },
      conversationId: "ancestor-conversation",
    });
    expect(recovered.command).toMatchObject({
      kind: "prepare_attempt",
      attempt: { attemptId: "node:attempt:2", conversationId: null, provenance: { _tag: "retry" } },
    });
  });

  it.each([{ gate: null }, { gate: "" }, { gate: [] }, { gate: "continue" }])("preserves conditional continuation after recovery of a root retry with $gate", ({ gate }) => {
    const then = { step: "follow", when: "gate", then: { step: "nested", when: null, then: null } } as const;
    const retried = startPreparedAttempt(acknowledge(transitionWorkflow(
      replayWorkflow(runningControl({ then, retry: { max: 2, stuck: true } })),
      {
        type: "ATTEMPT_FAILED",
        failure: {
          attemptId: "attempt", kind: "invalid_handoff", reason: "Missing evidence", conversationId: "conversation",
          content: {}, issues: [{ path: "evidence", message: "Missing evidence" }],
        },
      },
    )));
    const recovered = startPreparedAttempt(acknowledge(transitionWorkflow(
      replayWorkflow(retried.state.context.committed), { type: "RECOVER", progressed: [] },
    )));
    expect(recovered.state.context.committed.attempts[1]).toMatchObject({
      parentAttemptId: "attempt", provenance: { _tag: "retry" }, iteration: 2,
      priorRetryFeedback: "Missing evidence", resumeRevertCount: 1,
    });
    const completed = acknowledge(success(recovered.state, { gate }, "node:attempt:2"));
    if (gate === "continue") {
      const follow = startPreparedAttempt(completed);
      expect(follow.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "follow" }] });
      const nested = startPreparedAttempt(acknowledge(success(follow.state, {}, "node:attempt:3")));
      expect(nested.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "nested" }] });
      expect(acknowledge(success(nested.state, {}, "node:attempt:4")).state.context.committed.status).toBe("completed");
    } else {
      expect(completed.state.context.committed.status).toBe("completed");
      expect(completed.state.context.committed.attempts).toHaveLength(2);
    }
  });


  describe("a failed agent of an item before encoding 14", () => {
    /** A review over three items, then one agent; the review of `b` fails,
     *  and so does the agent when `soloFails`. */
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "items",
      name: "Items",
      input: { fields: { items: { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The item id." } } } } } },
      phases: [
        { phase: "review", over: "input.items", brief: "Review one item.", name: "Review", output: { summary: "The review." }, join: { reducer: "collect" } },
        { phase: "solo", brief: "Report.", name: "Solo", output: { summary: "The report." } },
      ],
    });
    const fails = (soloFails: boolean, definitionId: string, item: unknown) => (definitionId === "solo" && soloFails)
      || (typeof item === "object" && item !== null && "id" in item && item.id === "b");
    /** Run every attempt at `encoding`, one at a time, until nothing more can run. */
    const runAt = (encoding: WorkflowProposalEncoding, soloFails: boolean, from?: WorkflowTransitionResult): WorkflowTransitionResult => {
      const drive = (result: WorkflowTransitionResult, event: DecodedWorkflowEvent) => acknowledge(transitionDecodedWorkflow(result.state, event, encoding));
      let result = from ?? drive(initializeWorkflow(compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: testSkillRevision([]) }, launchGuardrailLimits(workflow, 50), { items: [{ id: "a" }, { id: "b" }, { id: "c" }] })), { type: "START" });
      for (;;) {
        if (result.command.kind === "prepare_attempt") {
          const { attemptId } = result.command.attempt;
          result = drive(result, { type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation:${attemptId}` });
        } else if (result.command.kind === "run_attempts") {
          const [next] = result.command.attempts;
          if (next === undefined) throw new Error("expected an attempt to run");
          const { attemptId, definitionId, item } = next;
          const conversationId = `conversation:${attemptId}`;
          result = drive(result, fails(soloFails, definitionId, item)
            ? { type: "ATTEMPT_FAILED", failure: { attemptId, kind: "fatal", reason: "rejected", conversationId } }
            : { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId, handoff: { summary: "done" }, reassessment: null } });
        } else return result;
      }
    };

    it("ends the run completed at encoding 13 and failed at encoding 14", () => {
      expect(runAt(13, false).state.context.committed.status).toBe("completed");
      expect(runAt(14, false).state.context.committed.status).toBe("failed");
    });

    it("reopens only the failed top-level agent on a Resume of encoding 13, and the item agent too at encoding 14", () => {
      const reopened = (encoding: WorkflowProposalEncoding) => {
        const failed = runAt(encoding, true);
        expect(failed.state.context.committed.status).toBe("failed");
        const resumed = acknowledge(transitionDecodedWorkflow(failed.state, { type: "RESUME", readers: {} }, encoding));
        return resumed.state.context.committed.attempts.filter(({ state }) => state._tag === "pending").map(({ definitionId }) => definitionId).toSorted();
      };
      expect(reopened(13)).toEqual(["solo"]);
      expect(reopened(14)).toEqual(["review", "solo"]);
    });
  });
});
