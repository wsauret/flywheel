import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { DurableFollowUpInputSchema, type DurableFollowUpInput } from "../../../../src/infra/chat-input-schema.js";
import { parseWorkflowEvent } from "../../../../src/workflows/vm/events.js";
import { buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { replayWorkflow, transitionDecodedWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import type { DecodedWorkflowEvent } from "../../../../src/workflows/vm/events.js";
import type { WorkflowMachineState } from "../../../../src/workflows/vm/control-types.js";
import { acknowledge, runningControl } from "./_machine-semantics-fixtures.js";
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js";

const identity = { kind: "identified", inputID: "original-input" } as const;
const richInput: DurableFollowUpInput = { text: "", attachments: [{ marker: "image", mediaType: "image/png", data: "aW1hZ2U=" }], invocation: { label: "explain", args: "image" }, origin: "human" };
const request = { type: "FOLLOW_UP_REQUESTED", conversationId: "follow-up", requestSequence: 1, input: richInput, identity } as const;

/** A follow-up run as a build before 2026-10-03 committed it: at encoding
 *  13, the last that holds one. Replay re-derives it at that encoding. */
function recorded(state: WorkflowMachineState, event: DecodedWorkflowEvent) {
  return transitionDecodedWorkflow(state, event, 13);
}

function requested() {
  const root = buildWorkflowControlInitializedFact({ ...runningControl(), attempts: [], graph: { nodes: [], dependencies: [], joins: [], budgets: [] }, status: "completed" });
  const result = recorded(replayWorkflow(root.payload.control), request);
  const pending = result.state.context.pending;
  if (!pending) throw new Error("Expected request proposal");
  return { root, result, facts: [root, ...pending.facts], control: pending.proposedCommitted };
}

describe("durable workflow follow-up input", () => {
  it("retains image-only input, invocation, origin and identity of a recorded request through facts and current recovery roots, and runs nothing", () => {
    const { root, result, facts, control } = requested();
    expect(root.version).toBe(12);
    expect(facts.slice(1).map(({ type, version }) => [type, version])).toEqual([["follow_up.requested", 2], ["workflow.control.committed", 13]]);
    expect(control.followUp).toEqual({ conversationId: "follow-up", requestSequence: 1, identity, pendingInput: richInput });
    expect(replayWorkflowControl(facts)).toEqual(control);
    // The pending input belongs to the parent chat: the host refuses it at
    // preflight, so the machine starts nothing for it.
    expect(acknowledge(result).command).toEqual({ kind: "none" });
    const template = recoveredWorkflowRoot(control, control.aggregateSeq + 1);
    const recovered = buildWorkflowControlRecoveredFact({ ...template.payload, control: { ...control, aggregateSeq: control.aggregateSeq + 1 } });
    expect(recovered.version).toBe(12);
    expect(replayWorkflowControl([{ ...recovered, seq: control.aggregateSeq }]).followUp).toEqual(control.followUp);
    expect(JSON.stringify(facts)).not.toContain("proposalEncoding");
    expect(JSON.stringify(control)).not.toContain("proposalEncoding");
  });

  it("replays a recorded run with FOLLOW_UP_REQUESTED and FOLLOW_UP_SUCCEEDED to the same status and positions", () => {
    const { facts, control } = requested();
    let state = replayWorkflow(control);
    for (const event of [
      { type: "FOLLOW_UP_FAILED", reason: "provider stopped", conversationId: "follow-up", requestSequence: 1 },
      { type: "PAUSE", reason: "operator" },
      { type: "RESUME", readers: {} },
      { type: "FOLLOW_UP_SUCCEEDED", conversationId: "follow-up", requestSequence: 1 },
    ] as const) {
      const result = recorded(state, event);
      const pending = result.state.context.pending;
      if (!pending) throw new Error("Expected proposal");
      expect(pending.facts.at(-1)?.version).toBe(13);
      facts.push(...pending.facts);
      state = acknowledge(result).state;
      expect(state.context.committed.followUp).toEqual({ conversationId: "follow-up", requestSequence: 1, identity, pendingInput: event.type === "FOLLOW_UP_SUCCEEDED" ? null : richInput });
      expect(replayWorkflowControl(facts)).toEqual(state.context.committed);
    }
    expect(state.context.committed.status).toBe("completed");
    expect(state.context.committed.aggregateSeq).toBe(replayWorkflowControl(facts).aggregateSeq);
    const second = recorded(state, { ...request, input: { text: "next" }, identity: { kind: "identified", inputID: "next-input" }, requestSequence: 2 });
    expect(second.state.context.pending?.proposedCommitted.followUp?.identity).toEqual({ kind: "identified", inputID: "next-input" });
  });

  it("refuses a follow-up request from a current writer, at the type and at the runtime boundary", () => {
    const completed = replayWorkflow(requested().root.payload.control);
    // @ts-expect-error A current writer proposes no follow-up run.
    expect(() => transitionWorkflow(completed, request)).toThrow();
    expect(() => parseWorkflowEvent(request)).toThrow();
    // A current terminal fact cannot hold one either.
    const committed = requested().facts.at(-1)!;
    expect(() => parseWorkflowSessionFact({ ...committed, version: 14 })).toThrow();
  });

  it("requires identified recorded requests and excludes dispatch correlation at the durable boundary", () => {
    const decode = Schema.decodeUnknownSync(DurableFollowUpInputSchema, { onExcessProperty: "error" });
    expect(decode(richInput)).toEqual(richInput);
    for (const input of [{ ...richInput, dispatchId: "transport" }, { ...richInput, dispatchIds: ["transport"] }, { ...richInput, origin: "agent" }]) {
      expect(() => decode(input)).toThrow();
    }
    for (const badIdentity of [{ kind: "historical" }, { kind: "identified", inputID: "" }, undefined]) {
      expect(() => parseWorkflowSessionFact({ type: "follow_up.requested", version: 2, actor: "flywheel", payload: { input: richInput, identity: badIdentity, conversationId: "follow-up", requestSequence: 1 } })).toThrow();
    }
  });
});
