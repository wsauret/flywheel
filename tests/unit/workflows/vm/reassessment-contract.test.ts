import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import type { Attempt, LogicalNode } from "../../../../src/workflows/vm/graph-types.js";
import { compileReassessmentOutput, compileRetiredReassessmentOutput } from "../../../../src/workflows/vm/reassessment-contract.js";
import { reassessesRetiredFor, reassessmentIssues, reassessmentProposal, type ReassessmentControl } from "../../../../src/workflows/vm/reassessment.js";
import { loadBriefs } from "../../../../src/workflows/brief.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";

const milestone = {
  type: "object",
  fields: {
    id: { type: "string", description: "The milestone id." },
    goal: { type: "string", description: "What the milestone delivers." },
  },
} as const;

const output = compileReassessmentOutput(milestone);
const workflow = { _tag: "workflow", workflowDefinitionId: "planned" } as const;
const REPEAT = "planned:node:2";
const ROUND_ONE = `${REPEAT}:round:1`;

function attempt(id: string, logicalNodeId: string, state: Attempt["state"], item: Attempt["item"]): Attempt {
  return {
    id, logicalNodeId, workflowDefinitionId: "planned", definitionId: logicalNodeId.endsWith(":node:1") ? "work" : "reassess",
    sequence: 1, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "authored" },
    ownership: { _tag: "round", workflowDefinitionId: "planned", parentNodeId: REPEAT, round: 1 },
    state, parentAttemptId: null, conversationId: null, handoff: null, priorRetryFeedback: null, item,
  };
}

function agent(id: string, definitionId: string): LogicalNode {
  return {
    kind: "agent", id, workflowDefinitionId: "planned", order: 2, definitionId, name: definitionId, retry: null, condition: null,
    ownership: { _tag: "round", workflowDefinitionId: "planned", parentNodeId: REPEAT, round: 1 }, state: { _tag: "running" },
  };
}

// Round 1 of a repeat over three milestones ran p1 and its reassessment
// runs; p2 and p3 wait for their rounds.
const items = [{ id: "p1", goal: "First" }, { id: "p2", goal: "Second" }, { id: "p3", goal: "Third" }];
const control: ReassessmentControl = {
  graph: {
    nodes: [
      {
        kind: "repeat", id: REPEAT, workflowDefinitionId: "planned", order: 1, ownership: workflow, state: { _tag: "running" }, name: "Repeat 2",
        loop: { _tag: "each", source: { nodeId: "planned:node:1", field: "milestones" }, width: 3, reassess: `${ROUND_ONE}:node:2`, items },
      },
      agent(`${ROUND_ONE}:node:1`, "work"),
      agent(`${ROUND_ONE}:node:2`, "reassess"),
    ],
    dependencies: [], joins: [], budgets: [],
  },
  attempts: [
    attempt("work-1", `${ROUND_ONE}:node:1`, { _tag: "completed" }, items[0]!),
    attempt("reassess-1", `${ROUND_ONE}:node:2`, { _tag: "running" }, items[0]!),
  ],
};
const owner = { attemptId: "reassess-1", logicalNodeId: `${ROUND_ONE}:node:2` };

describe("the reassess contract of a repeat over items", () => {
  it("takes its item shape from the each source and decodes drop, replace, and insert", () => {
    const payload = Schema.decodeUnknownSync(output.schema)({
      summary: "Milestone two is obsolete, milestone three needs a new goal, and a cleanup milestone follows milestone one.",
      changes: [
        { action: "drop", item_id: "p2" },
        { action: "replace", item_id: "p3", item: { id: "p3", goal: "Third, revised" } },
        { action: "insert", item_id: "p1", item: { id: "p1b", goal: "Clean up" } },
      ],
    });
    expect(() => Schema.decodeUnknownSync(output.schema)({ summary: "x", changes: [{ action: "insert", item_id: "p1", item: { id: "p1b" } }] })).toThrow();

    const handoff = { retired: false, payload } as const;
    expect(reassessmentIssues(handoff, owner, control)).toEqual([]);
    expect(reassessmentProposal(handoff, owner, control)).toEqual({
      proposalId: "reassess-1:reassessment",
      ownerNodeId: owner.logicalNodeId,
      reason: payload.summary,
      changes: [
        { kind: "drop_item", repeatNodeId: REPEAT, itemId: "p2", reason: 'Reassess dropped item "p2"' },
        { kind: "replace_item", repeatNodeId: REPEAT, itemId: "p3", item: { id: "p3", goal: "Third, revised" }, reason: 'Reassess replaced item "p3"' },
        { kind: "insert_item", repeatNodeId: REPEAT, afterItemId: "p1", item: { id: "p1b", goal: "Clean up" }, reason: 'Reassess inserted an item after "p1"' },
      ],
    });
  });

  it("proposes nothing for an empty changes list", () => {
    const payload = Schema.decodeUnknownSync(output.schema)({ summary: "The remaining milestones stand.", changes: [] });
    expect(reassessmentProposal({ retired: false, payload }, owner, control)).toBeNull();
  });

  it("refuses a proposed item id that an item already carries, and a change that names no remaining item", () => {
    const payload = Schema.decodeUnknownSync(output.schema)({
      summary: "Insert a milestone.",
      changes: [{ action: "insert", item_id: "p1", item: { id: "p2", goal: "Clash" } }, { action: "drop", item_id: "p1" }],
    });
    expect(reassessmentIssues({ retired: false, payload }, owner, control).map(({ path }) => path)).toEqual(["changes.1.item_id", "changes.0.item.id"]);
  });

  it("judges each change against the items that the changes before it leave", () => {
    const issues = (changes: readonly unknown[]) => reassessmentIssues({ retired: false, payload: Schema.decodeUnknownSync(output.schema)({ summary: "Change the milestones.", changes }) }, owner, control);
    const gone = (id: string) => ({ path: "changes.1.item_id", message: `Item id "${id}" names an item that an earlier change of this reassessment dropped or replaced`, hint: "Name each item that a change acts on once, and anchor an insert on an item that stays." });
    expect(issues([{ action: "drop", item_id: "p2" }, { action: "drop", item_id: "p2" }])).toEqual([gone("p2")]);
    expect(issues([{ action: "drop", item_id: "p2" }, { action: "insert", item_id: "p2", item: { id: "p2b", goal: "After two" } }])).toEqual([gone("p2")]);
    expect(issues([{ action: "replace", item_id: "p3", item: { id: "p3b", goal: "Third, renamed" } }, { action: "drop", item_id: "p3" }])).toEqual([gone("p3")]);
    // An insert may anchor on an item that an earlier insert added.
    expect(issues([{ action: "insert", item_id: "p1", item: { id: "p1b", goal: "Clean up" } }, { action: "insert", item_id: "p1b", item: { id: "p1c", goal: "Document" } }])).toEqual([]);
  });
});

// A `for` node of control from before phases keeps the frozen contract that
// named each item a phase, so a paused run resumes. Remove after 2027-04-30.
describe("the reassess contract of a for node from before phases", () => {
  const retiredOutput = compileRetiredReassessmentOutput(milestone);
  const retiredAttempt = (id: string, state: Attempt["state"], item: Attempt["item"], parentAttemptId: string | null = null): Attempt => ({
    id, logicalNodeId: "phases", workflowDefinitionId: "phased", definitionId: item === null ? "reassess" : "work",
    sequence: 1, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "round", index: 1 },
    ownership: { _tag: "workflow", workflowDefinitionId: "phased" }, state, parentAttemptId, conversationId: null, handoff: null, priorRetryFeedback: null, item,
  });
  const retired: ReassessmentControl = {
    graph: {
      nodes: [{
        kind: "for", id: "phases", workflowDefinitionId: "phased", order: 0, ownership: { _tag: "workflow", workflowDefinitionId: "phased" },
        state: { _tag: "running" }, source: { step: "plan", field: "phases" }, body: [{ step: "work" }],
      }],
      dependencies: [], joins: [], budgets: [],
    },
    attempts: [
      retiredAttempt("work-1", { _tag: "completed" }, { id: "p1", goal: "First" }),
      retiredAttempt("reassess-1", { _tag: "running" }, null, "work-1"),
      retiredAttempt("work-2", { _tag: "pending" }, { id: "p2", goal: "Second" }),
      retiredAttempt("work-3", { _tag: "pending" }, { id: "p3", goal: "Third" }),
    ],
  };
  const retiredOwner = { attemptId: "reassess-1", logicalNodeId: "phases" };

  it("reads phase_id and phase, and proposes attempt changes", () => {
    expect(reassessesRetiredFor(retiredOwner, retired)).toBe(true);
    expect(reassessesRetiredFor(owner, control)).toBe(false);
    const payload = Schema.decodeUnknownSync(retiredOutput.schema)({
      summary: "Phase two is obsolete, phase three needs a new goal, and a cleanup phase follows phase one.",
      changes: [
        { action: "drop", phase_id: "p2" },
        { action: "replace", phase_id: "p3", phase: { id: "p3", goal: "Third, revised" } },
        { action: "insert", phase_id: "p1", phase: { id: "p1b", goal: "Clean up" } },
      ],
    });
    const handoff = { retired: true, payload } as const;
    expect(reassessmentIssues(handoff, retiredOwner, retired)).toEqual([]);
    expect(reassessmentProposal(handoff, retiredOwner, retired)).toEqual({
      proposalId: "reassess-1:reassessment",
      ownerNodeId: "phases",
      reason: payload.summary,
      changes: [
        { kind: "skip", targetAttemptId: "work-2", reason: 'Reassess dropped phase "p2"' },
        { kind: "replace", targetAttemptId: "work-3", attemptId: "reassess-1:reassessment:2", forItem: { id: "p3", goal: "Third, revised" }, reason: 'Reassess replaced phase "p3"' },
        { kind: "insert_after", targetAttemptId: "work-1", afterAttemptId: "reassess-1", attemptId: "reassess-1:reassessment:3", forItem: { id: "p1b", goal: "Clean up" }, reason: 'Reassess inserted a phase after "p1"' },
      ],
    });
  });
});

describe("loading a reassess phase", () => {
  const planned = (reassess: { readonly output?: { readonly summary: string } } = {}) => Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "planned",
    name: "Planned",
    phases: [
      { phase: "plan", name: "Plan", brief: "Write the milestones.", output: { fields: { milestones: { type: "list", max: 3, unique: "id", of: milestone, description: "The milestones." } } } },
      {
        repeat: { each: "plan.milestones", reassess: "reassess" },
        phases: [
          { phase: "work", name: "Work", brief: "Do the milestone." },
          { phase: "reassess", name: "Reassess", brief: "Check the remaining milestones.", ...reassess },
        ],
      },
    ],
  });

  it("gives the reassess phase the VM contract for the item type of its repeat", () => {
    const contents = loadBriefs(planned(), undefined).briefs;
    const reassess = contents.get("reassess");
    expect(reassess?.reassesses).toBe(true);
    expect(reassess?.output.schemaSha256).toBe(output.schemaSha256);
    expect(contents.get("work")?.reassesses).toBe(false);
  });

  it("refuses an output that the reassess phase declares itself", () => {
    expect(() => loadBriefs(planned({ output: { summary: "Mine." } }), undefined))
      .toThrow("the VM owns the output of a reassess phase; remove its output");
  });
});
