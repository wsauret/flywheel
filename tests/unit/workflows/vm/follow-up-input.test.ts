import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { DurableFollowUpInputSchema, type DurableFollowUpInput } from "../../../../src/infra/chat-input-schema.js";
import { parseWorkflowEvent } from "../../../../src/workflows/vm/events.js";
import { buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { continueCommittedWorkflow, replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import { acknowledge, runningControl } from "./_machine-semantics-fixtures.js";
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js";

const identity = { kind: "identified", inputID: "original-input" } as const;
const richInput: DurableFollowUpInput = { text: "", attachments: [{ marker: "image", mediaType: "image/png", data: "aW1hZ2U=" }], invocation: { label: "explain", args: "image" }, origin: "human" };
const request = { type: "FOLLOW_UP_REQUESTED", conversationId: "follow-up", requestSequence: 1, input: richInput, identity } as const;

function requested() {
  const root = buildWorkflowControlInitializedFact({ ...runningControl(), attempts: [], graph: { nodes: [], dependencies: [], joins: [], budgets: [] }, status: "completed" });
  const result = transitionWorkflow(replayWorkflow(root.payload.control), request);
  const pending = result.state.context.pending;
  if (!pending) throw new Error("Expected request proposal");
  return { root, result, facts: [root, ...pending.facts], control: pending.proposedCommitted };
}

describe("durable workflow follow-up input", () => {
  it("retains image-only input, invocation, origin and identity through facts, commands and current recovery roots", () => {
    const { root, result, facts, control } = requested();
    expect(root.version).toBe(12);
    expect(facts.slice(1).map(({ type, version }) => [type, version])).toEqual([["follow_up.requested", 2], ["workflow.control.committed", 14]]);
    expect(control.followUp).toEqual({ conversationId: "follow-up", requestSequence: 1, identity, pendingInput: richInput });
    expect(replayWorkflowControl(facts)).toEqual(control);
    const expectedCommand = { kind: "run_follow_up", input: { workflowDefinitionId: "semantic", conversationId: "follow-up", requestSequence: 1, identity, input: richInput } } as const;
    expect(acknowledge(result).command).toEqual(expectedCommand);
    expect(continueCommittedWorkflow(control).command).toEqual(expectedCommand);
    const template = recoveredWorkflowRoot(control, control.aggregateSeq + 1);
    const recovered = buildWorkflowControlRecoveredFact({ ...template.payload, control: { ...control, aggregateSeq: control.aggregateSeq + 1 } });
    expect(recovered.version).toBe(12);
    expect(replayWorkflowControl([{ ...recovered, seq: control.aggregateSeq }]).followUp).toEqual(control.followUp);
    expect(JSON.stringify(facts)).not.toContain("proposalEncoding");
    expect(JSON.stringify(control)).not.toContain("proposalEncoding");
  });

  it("preserves failed input across pause and resume, then clears only input after success", () => {
    const { facts, control } = requested();
    let state = replayWorkflow(control);
    for (const event of [
      { type: "FOLLOW_UP_FAILED", reason: "provider stopped", conversationId: "follow-up", requestSequence: 1 },
      { type: "PAUSE", reason: "operator" },
      { type: "RESUME", readers: {} },
      { type: "FOLLOW_UP_SUCCEEDED", conversationId: "follow-up", requestSequence: 1 },
    ] as const) {
      const result = transitionWorkflow(state, event);
      const pending = result.state.context.pending;
      if (!pending) throw new Error("Expected proposal");
      facts.push(...pending.facts);
      state = acknowledge(result).state;
      expect(state.context.committed.followUp).toEqual({ conversationId: "follow-up", requestSequence: 1, identity, pendingInput: event.type === "FOLLOW_UP_SUCCEEDED" ? null : richInput });
      expect(replayWorkflowControl(facts)).toEqual(state.context.committed);
    }
    const second = transitionWorkflow(state, { ...request, input: { text: "next" }, identity: { kind: "identified", inputID: "next-input" }, requestSequence: 2 });
    expect(second.state.context.pending?.proposedCommitted.followUp?.identity).toEqual({ kind: "identified", inputID: "next-input" });
  });

  it("requires identified current requests and excludes dispatch correlation at the durable boundary", () => {
    const decode = Schema.decodeUnknownSync(DurableFollowUpInputSchema, { onExcessProperty: "error" });
    expect(decode(richInput)).toEqual(richInput);
    expect(parseWorkflowEvent(request)).toEqual(request);
    for (const input of [{ ...richInput, dispatchId: "transport" }, { ...richInput, dispatchIds: ["transport"] }, { ...richInput, origin: "agent" }]) {
      expect(() => decode(input)).toThrow();
      expect(() => parseWorkflowEvent({ ...request, input })).toThrow();
    }
    for (const badIdentity of [{ kind: "historical" }, { kind: "identified", inputID: "" }, undefined]) {
      expect(() => parseWorkflowEvent({ ...request, identity: badIdentity })).toThrow();
      expect(() => parseWorkflowSessionFact({ type: "follow_up.requested", version: 2, actor: "flywheel", payload: { input: richInput, identity: badIdentity, conversationId: "follow-up", requestSequence: 1 } })).toThrow();
    }
    expect(() => parseWorkflowEvent({ type: "FOLLOW_UP_REQUESTED", prompt: "old", conversationId: "follow-up", requestSequence: 1 })).toThrow();
  });
});
