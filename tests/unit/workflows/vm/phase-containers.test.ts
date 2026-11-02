import { afterEach, describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { completeAttempt, prepareExecution, startExecution } from "../../../../src/workflows/vm/attempt-transitions.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { replayWorkflow, transitionDecodedWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import { parseWorkflowEvent } from "../../../../src/workflows/vm/events.js";
import { withNodeState } from "../../../../src/workflows/vm/graph-changes.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { acknowledge } from "./_machine-semantics-fixtures.js";
import { attemptOf, branch, completePlan, itemList, items, MAP_GROUP, mapSkills, mapWorkflow, PLAN, runPrepared, stage, TAIL } from "./_map-fixtures.js";
import { SqliteVmDriver } from "./_sqlite-vm-driver.js";
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js";

// Production machine semantics of phase, list, and item containers:
// preparation sweeps that open, expand, and settle them, graph-order attempt
// selection, and the structural admission of reassessment proposals inside
// them.

const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

function mapDriver(workflow = mapWorkflow, skills = mapSkills): SqliteVmDriver {
  const vm = new SqliteVmDriver({ workflow, skills });
  drivers.push(vm);
  return vm;
}

const types = (facts: readonly { readonly type: string }[]) => facts.map(({ type }) => type);
const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id, writes: [] });

/** Real compiled control of a workflow whose phase outer has the named
 *  agents one and two, and whose phase three runs after it. */
function phaseControl(join?: { readonly reducer: string; readonly write: string }): CommittedWorkflowControl {
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "phased",
    name: "Phased",
    phases: [{ phase: "outer", agents: [{ agent: "one", ...record("one") }, { agent: "two", ...record("two") }], ...(join === undefined ? {} : { join }) }, { phase: "three", ...record("three") }],
  });
  return compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills: phaseSkills });
}

const phaseSkills = testSkillRevision([]);
const OUTER = "phased:node:1";
const ONE = `${OUTER}:node:1`;
const TWO = `${OUTER}:node:2`;
const THREE = "phased:node:2";

/** The control with these node and attempt states, keyed by node id. */
function withStates(
  control: CommittedWorkflowControl,
  nodes: { readonly [nodeId: string]: CommittedWorkflowControl["graph"]["nodes"][number]["state"] },
  attempts: { readonly [nodeId: string]: CommittedWorkflowControl["attempts"][number]["state"] },
): CommittedWorkflowControl {
  return {
    ...control,
    status: "executing",
    graph: { ...control.graph, nodes: control.graph.nodes.map((node) => {
      const state = nodes[node.id];
      return state ? withNodeState(node, state) : node;
    }) },
    attempts: control.attempts.map((attempt) => {
      const state = attempts[attempt.logicalNodeId];
      return state ? { ...attempt, state, handoff: state._tag === "completed" ? { summary: `${attempt.definitionId} done` } : null } : attempt;
    }),
  };
}

const states = (control: CommittedWorkflowControl) => Object.fromEntries(control.graph.nodes.map(({ id, state }) => [id, state._tag]));

describe("workflow machine phase containers", () => {
  it("opens a phase in a preparation sweep so its agents are the first frontier", () => {
    const prepared = prepareExecution(phaseControl());
    expect(states(prepared.control)).toEqual({ [OUTER]: "running", [ONE]: "ready", [TWO]: "ready", [THREE]: "pending" });
    expect(prepared.control.status).toBe("ready");
    expect(prepared.facts).toEqual([]);
  });

  it("settles a phase once its agents end and releases the work after it", () => {
    const control = withStates(phaseControl(),
      { [OUTER]: { _tag: "running" }, [ONE]: { _tag: "completed" }, [TWO]: { _tag: "completed" } },
      { [ONE]: { _tag: "completed" }, [TWO]: { _tag: "completed" } });
    const prepared = prepareExecution(control);
    expect(states(prepared.control)).toEqual({ [OUTER]: "completed", [ONE]: "completed", [TWO]: "completed", [THREE]: "ready" });
    expect(prepared.control.status).toBe("ready");
  });

  it.each([undefined, { reducer: "collect", write: "all" }])("fails a phase whose agent failed with join %j, and fails the workflow through the nodes it owns", (join) => {
    const control = withStates(phaseControl(join),
      { [OUTER]: { _tag: "running" }, [ONE]: { _tag: "completed" }, [TWO]: { _tag: "failed", reason: "worker failed" } },
      { [ONE]: { _tag: "completed" }, [TWO]: { _tag: "failed", reason: "worker failed" } });
    const prepared = prepareExecution(control);
    expect(states(prepared.control)).toEqual({ [OUTER]: "failed", [ONE]: "completed", [TWO]: "failed", [THREE]: "blocked" });
    expect(prepared.control.graph.nodes.find(({ id }) => id === OUTER)?.state).toEqual({ _tag: "failed", reason: `Phase work did not complete: ${TWO}` });
    expect(prepared.control.status).toBe("failed");
    expect(prepared.facts.map(({ type }) => type)).toEqual(["group.settled", "workflow.failed"]);
  });

  it("completes a phase whose remaining agents were cancelled", () => {
    const control = withStates(phaseControl(),
      { [OUTER]: { _tag: "running" }, [ONE]: { _tag: "completed" }, [TWO]: { _tag: "cancelled", reason: "replanned", causedBy: [] } },
      { [ONE]: { _tag: "completed" }, [TWO]: { _tag: "skipped", reason: "replanned" } });
    const prepared = prepareExecution(control);
    expect(states(prepared.control)).toMatchObject({ [OUTER]: "completed", [TWO]: "cancelled", [THREE]: "ready" });
  });

  it("replays a recorded encoding 11 join that completed despite a failed named agent", () => {
    const control = withStates(phaseControl({ reducer: "collect", write: "all" }),
      { [OUTER]: { _tag: "running" }, [ONE]: { _tag: "running" }, [TWO]: { _tag: "failed", reason: "worker failed" } },
      { [ONE]: { _tag: "running" }, [TWO]: { _tag: "failed", reason: "worker failed" } });
    const root = buildWorkflowControlInitializedFact(control);
    const proposed = transitionDecodedWorkflow(replayWorkflow(root.payload.control), {
      type: "ATTEMPT_SUCCEEDED",
      outcome: { attemptId: `${ONE}:attempt:1`, conversationId: null, handoff: { summary: "one done" }, reassessment: null },
    }, 11);
    const pending = proposed.state.context.pending;
    if (!pending) throw new Error("Missing historical proposal");
    expect(states(pending.proposedCommitted)).toMatchObject({ [OUTER]: "completed", [TWO]: "failed", [THREE]: "ready" });
    expect(replayWorkflowControl([root, ...pending.facts])).toEqual(pending.proposedCommitted);
  });

  it("selects the next attempt by graph order, not attempt array order", () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "siblings",
      name: "Siblings",
      phases: [{ phase: "both", agents: [{ agent: "one", ...record("one") }, { agent: "two", ...record("two") }] }],
    });
    const compiled = compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills: phaseSkills });
    expect(compiled.graph.dependencies).toEqual([]);
    const reversed = { ...compiled, attempts: compiled.attempts.toReversed() };
    const started = acknowledge(transitionWorkflow(replayWorkflow(reversed), { type: "START" }));
    expect(started.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: "siblings:node:1:node:1:attempt:1" } });
  });

  it("gives an inserted attempt its anchor's owner and refuses a proposal that crosses containers", () => {
    const base = withStates(phaseControl(),
      { [OUTER]: { _tag: "running" }, [ONE]: { _tag: "completed" } },
      { [ONE]: { _tag: "completed" } });
    const proposal = (changes: readonly unknown[]) => transitionWorkflow(replayWorkflow(base), parseWorkflowEvent({
      type: "REASSESSMENT_PROPOSED",
      proposal: { proposalId: "reassess", ownerNodeId: ONE, reason: "change", changes },
    }));
    const two = base.attempts.find(({ logicalNodeId }) => logicalNodeId === TWO);
    if (!two) throw new Error("fixture attempt missing");
    const inserted = proposal([{
      kind: "insert_after", targetAttemptId: two.id, afterAttemptId: two.id, attemptId: "inserted", forItem: { id: "more" }, reason: "insert",
    }]);
    const pending = inserted.state.context.pending;
    if (!pending) throw new Error("Expected a proposal");
    expect(pending.proposedCommitted.attempts.find(({ id }) => id === "inserted")?.ownership)
      .toEqual({ _tag: "phase", workflowDefinitionId: "phased", phaseId: "outer", parentNodeId: OUTER });

    expect(() => proposal([{ kind: "add_dependency", dependency: { nodeId: THREE, dependsOn: TWO } }]))
      .toThrow(/invalid_dependency_target: Node "phased:node:2" depends on "phased:node:1:node:2", which another container owns/);
  });
});

describe("workflow machine lists", () => {
  it("expands with item provenance and the frozen shared bundle, and keeps the parent open while a descendant is pending", async () => {
    const vm = mapDriver();
    const expanded = await completePlan(vm, items("a", "b"));
    expect(types(vm.batches.at(-1) ?? [])).toEqual(expect.arrayContaining(["attempt.succeeded", "group.expanded", "workflow.control.committed"]));
    expect(expanded.command).toMatchObject({
      kind: "prepare_attempt",
      attempt: {
        attemptId: attemptOf(stage(1, 1)),
        provenance: { _tag: "item", ordinal: 1 },
        item: { id: "a", title: "Item a" },
        scope: { _tag: "item", listNodeId: MAP_GROUP, itemNodeId: branch(1), key: "a", sharedEntryIds: [attemptOf(PLAN)] },
      },
    });
    expect(vm.committed.graph.nodes.find(({ id }) => id === branch(2))).toMatchObject({ kind: "item", key: "b", label: "Item b", ordinal: 2 });

    const reviewed = await runPrepared(vm, await runPrepared(vm, expanded, { summary: "implemented a" }), { summary: "reviewed a" });
    expect(states(vm.committed)).toMatchObject({ [branch(1)]: "completed", [branch(2)]: "running", [MAP_GROUP]: "running", [TAIL]: "pending" });
    expect(types(vm.events())).not.toContain("group.settled");
    expect(reviewed.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: attemptOf(stage(2, 1)) } });
  });

  it("settles an empty list once in the expansion commit with no worker and continues", async () => {
    const vm = mapDriver();
    const prepared = await completePlan(vm, []);
    const batch = vm.batches.at(-1) ?? [];
    expect(types(batch).filter((type) => type.startsWith("group."))).toEqual(["group.expanded", "group.settled"]);
    expect(batch.find(({ type }) => type === "group.settled")?.payload).toMatchObject({ input: [], output: { total: 0, completed: 0, failed: 0, items: [] } });
    expect(states(vm.committed)).toMatchObject({ [MAP_GROUP]: "completed", [TAIL]: "ready" });
    expect(vm.committed.attempts.map(({ id }) => id)).toEqual([attemptOf(PLAN), attemptOf(TAIL)]);
    expect(prepared.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: attemptOf(TAIL) } });
    expect(types(vm.events()).filter((type) => type === "group.settled")).toHaveLength(1);
  });

  it.each([
    ["repeated keys", [...items("a"), ...items("a")], /items repeat the key "a"/],
    ["more items than the declared max", items("a", "b", "c", "d"), /holds 4 items, more than its declared max of 3/],
    ["an item without its key", [{ title: "No id" }], /item 1 has no string "id"/],
  ] as const)("rejects an expansion over %s and commits no graph change", async (_name, list, reason) => {
    const vm = mapDriver();
    await vm.initialize();
    const nodes = vm.committed.graph.nodes.map(({ id }) => id);
    await completePlan(vm, list, true);
    const batch = vm.batches.at(-1) ?? [];
    expect(types(batch).filter((type) => type.startsWith("group.") || type.startsWith("workflow."))).toEqual([
      "group.expansion_rejected", "workflow.failed", "workflow.control.committed",
    ]);
    expect(String(batch.find(({ type }) => type === "group.expansion_rejected")?.payload.reason)).toMatch(reason);
    expect(vm.committed.graph.nodes.map(({ id }) => id)).toEqual(nodes);
    expect(vm.committed.graph.joins).toEqual([]);
    expect(vm.committed.status).toBe("failed");
    expect(replayWorkflowControl(vm.events())).toEqual(vm.committed);
  });

  it("runs a list over the join output of another list", async () => {
    const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(mapWorkflow);
    const [plan, implement, review] = encoded.phases;
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...encoded,
      phases: [plan, implement, { ...review, join: { reducer: "collect" } }, { phase: "recheck", over: "review.items", brief: "Recheck one result.", name: "Recheck", writes: [], join: { reducer: "collect" } }],
    });
    const vm = mapDriver(workflow, testSkillRevision(["plan", "implement", "review", "recheck"].map((id) => testSkill(id))));
    let next = await completePlan(vm, items("a", "b"));
    for (const summary of ["implemented a", "reviewed a", "implemented b", "reviewed b"]) next = await runPrepared(vm, next, { summary });
    const second = vm.committed.graph.nodes.find((node) => node.kind === "list" && node.id !== MAP_GROUP);
    if (second?.kind !== "list") throw new Error("Expected the second list");
    expect(second).toMatchObject({ source: { nodeId: MAP_GROUP, field: "items" }, key: "key", width: 3, state: { _tag: "running" } });
    expect(second.admittedContext).toEqual([attemptOf(PLAN), `${MAP_GROUP}:join`]);
    expect(next.command).toMatchObject({
      kind: "prepare_attempt",
      attempt: { definitionId: "recheck", item: { key: "a", disposition: "completed", handoff: { step_id: attemptOf(stage(1, 2)) } } },
    });
    expect(replayWorkflowControl(vm.events())).toEqual(vm.committed);
  });

  it("fails only the item when an agent's retry does not fit the attempt limit", async () => {
    const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(mapWorkflow);
    const [plan, implement, review, tail] = encoded.phases;
    // Plan, 24 items of two phases, and the tail fill the attempt limit of 50.
    const vm = mapDriver(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      ...encoded,
      phases: [{ ...plan, output: { summary: "The plan.", fields: { items: itemList(24) } } }, { ...implement, retry: { max: 2 } }, review, tail],
    }));
    await vm.initialize();
    await vm.startAttempt("after", "conversation-plan");
    await vm.completeAttempt("after", { summary: "The plan.", items: items(...Array.from({ length: 24 }, (_, index) => `item-${index + 1}`)) });
    await vm.startAttempt("after", "conversation-a");
    await vm.failHandoff();
    expect(types(vm.events())).not.toContain("attempt.insertion_rejected");
    expect(types(vm.events())).not.toContain("workflow.failed");
    const group = "mapped:node:2";
    expect((await vm.drive({ type: "START" })).command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: `${group}:item:2:phase:1:attempt:1` } });
    expect(vm.committed.graph.nodes.find(({ id }) => id === `${group}:item:1`)?.state).toMatchObject({ _tag: "failed" });
    expect(vm.events().filter(({ type }) => type === "attempt.failed").map(({ payload }) => payload)).toEqual([{
      attemptId: `${group}:item:1:phase:1:attempt:1`, kind: "invalid_handoff",
      reason: 'summary is required. Workflow control "retry" rejected insert_after: max attempts (50)',
    }]);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.committed);
    expect(vm.committed.guardrails.maxAttempts).toBe(50);
    expect(vm.committed.attempts).toHaveLength(50);
  });

  it("settles a transition of a wide list in work linear in its graph, not in its graph times its items", () => {
    const wide = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "wide",
      name: "Wide",
      input: { fields: { items: itemList(256) } },
      phases: [
        { phase: "check", over: "input.items", label: "title", brief: "Check one item.", name: "Check", output: { summary: "The check." }, join: { reducer: "collect", write: { id: "checks", lifetime: "transient" } } },
        { phase: "report", brief: "Report the checks.", name: "Report", output: { summary: "The report." } },
      ],
    });
    const skills = testSkillRevision(["check", "report"].map((id) => testSkill(id)));
    // Node copies keep their ownership object, so a read of it counts
    // through every copy that a transition makes.
    const ownershipReadsPerNode = (count: number): number => {
      const ids = Array.from({ length: count }, (_, index) => `item-${index}`);
      const launched = compileWorkflowControl(wide, resolveWorkflowAgents(wide), { skills }, { maxAttempts: count + 1, maxMutationsPerAttempt: 3, maxInserts: 20 }, { items: items(...ids) });
      let control = prepareExecution(launched).control;
      for (const attempt of control.attempts.filter(({ provenance }) => provenance._tag === "item")) {
        control = startExecution(control, attempt.id, `conversation-${attempt.id}`).control;
      }
      let reads = 0;
      const counted = <T extends object>(ownership: T): T => Object.defineProperties({ ...ownership }, Object.fromEntries(Object.entries(ownership).map(([key, value]) => [key, { enumerable: true, get: () => { reads += 1; return value; } }])));
      control = { ...control, graph: { ...control.graph, nodes: control.graph.nodes.map((node) => ({ ...node, ownership: counted(node.ownership) })) } };
      const first = control.attempts.find(({ provenance }) => provenance._tag === "item");
      if (!first) throw new Error("fixture attempt missing");
      completeAttempt(control, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: first.id, conversationId: `conversation-${first.id}`, handoff: { summary: "checked" }, reassessment: null } });
      return reads / control.graph.nodes.length;
    };
    // A list wider than the sixty-four agents that a cache holds per family.
    expect(ownershipReadsPerNode(128)).toBeLessThan(ownershipReadsPerNode(8) * 1.5);
  });

  it("refuses a reassessment that targets the work of a list's item", async () => {
    const vm = mapDriver();
    await completePlan(vm, items("a"));
    expect(() => transitionWorkflow(replayWorkflow({ ...vm.committed, status: "executing" }), parseWorkflowEvent({
      type: "REASSESSMENT_PROPOSED",
      proposal: { proposalId: "reassess", ownerNodeId: PLAN, reason: "change", changes: [{ kind: "add_dependency", dependency: { nodeId: stage(1, 2), dependsOn: PLAN } }] },
    }))).toThrow(/belongs to a list or a repeat, which only expansion and rounds change/);
  });
});
