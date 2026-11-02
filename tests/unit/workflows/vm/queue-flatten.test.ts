import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { flattenWorkflowView, restateWorkflowView, workflowViewForProposal } from "../../../../src/workflows/vm/view-flatten.js";
import { workflowTree as projectTree } from "../../../../src/workflows/vm/view-tree.js";
import { MAP_GROUP, PLAN, TAIL, attemptOf, branch, items, stage } from "./_map-fixtures.js";

const IMPLEMENT = `${MAP_GROUP}:phase:1`;
const REVIEW = `${MAP_GROUP}:phase:2`;
import { drive, interrupt, mapBindings, mapControl, mapOutcome, phaseControl, startNext, wideControl } from "./_tree-fixtures.js";
import { completeAttempt, failAttempt, prepareExecution, startExecution } from "../../../../src/workflows/vm/attempt-transitions.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js";
import { asThenChain } from "../../../helpers/control-before-phases.js";
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import arms from "./golden/committed-v10-history-arms.json";

const skills = testSkillRevision([]);
const list = { type: "list", optional: true, max: 2, unique: "id", description: "Items.", of: { type: "object", fields: { id: { type: "string", description: "Id." } } } };
const { optional: _optional, ...requiredList } = list;
const field = (description: string) => ({ type: "string", optional: true, description });
const phase = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ phase: id, brief: `Do the ${id} work.`, name: id, writes: [{ id: `${id}-artifact`, lifetime: "transient" }], ...extra });

/** Decode a workflow of `phases`, and resolve its agents. */
function plan(phases: readonly unknown[]) {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "plan", name: "Plan", phases });
  return { workflow, agents: resolveWorkflowAgents(workflow) };
}

const flattened = plan([
  phase("linear", { retry: { max: 2, stuck: true }, output: { summary: "Linear.", fields: { items: list } } }),
  { repeat: { while: "review.continue", max: 3, stuck: true }, phases: [phase("work"), phase("review", { output: { summary: "Review.", fields: { continue: field("Why another round runs.") } } })] },
]);

function control() {
  return compileWorkflowControl(flattened.workflow, flattened.agents, { skills });
}

describe("workflow queue flattening", () => {
  it("is a deterministic projection of control and agents only", () => {
    const committed = control();
    const first = flattenWorkflowView(committed, flattened.agents);
    const second = flattenWorkflowView(structuredClone(committed), new Map([...flattened.agents].toReversed()));

    expect(first).toEqual(second);
    expect(first.attempts.map(({ definitionId }) => definitionId)).toEqual(["linear", "work", "review"]);
    expect(first.attempts[0]).toMatchObject({ status: "pending", briefId: "plan.linear" });
    expect(first.attempts.map(({ writes }) => writes)).toEqual([["linear-artifact"], ["work-artifact"], ["review-artifact"]]);
    expect(first.mutationLog).toEqual([]);
  });

  it("adds mutation history from the caught-up queue with committed attempt provenance", () => {
    const previous = control();
    const current = flattenWorkflowView(previous, flattened.agents);
    const retry = { ...previous.attempts[0]!, id: "retry-attempt", sequence: 2, provenance: { _tag: "retry" as const } };
    const completion = { ...previous.attempts[0]!, id: "then-attempt", sequence: 3, provenance: { _tag: "followUpV10" as const }, definitionId: "review" };
    const proposed = { ...previous, attempts: [...previous.attempts, retry, completion] };
    const target = workflowViewForProposal(current, proposed, flattened.agents, 100);

    expect(target.mutationLog).toEqual([
      expect.objectContaining({ actor: "retry", attemptIds: [retry.id] }),
      expect.objectContaining({ actor: "authored", attemptIds: [completion.id] }),
    ]);
    expect(target.attempts.find(({ id }) => id === completion.id)?.name).toBe("review");
  });

  it("writes the attempt rows of a while loop from before phases in the strict stored shape, each agent its own single phase of a round", () => {
    const agents = testResolvedAgents(["source", "a", "b", "c"].map((id) => testResolvedAgent(id, testSkill(id))));
    const view = flattenWorkflowView(replayWorkflowControl([parseWorkflowSessionFact(arms.whileBound2.root)]), agents);
    // The queue fact parser is the strict stored shape, so each row must decode there.
    expect(queueFactsForState(null, view)[0]?.type).toBe("queue.created");
    expect(view.tree.nodes.map(({ kind }) => kind)).toEqual(["phase", "agent", "repeat", "phase", "agent", "phase", "agent", "phase", "agent"]);
    expect(view.tree.nodes.filter((node) => node.kind === "agent" && node.nodeId === "loop:node:2").map((node) => node.kind === "agent" ? node.definitionId : "")).toEqual(["a", "b", "c"]);
  });

  it.each([200, 2_000])("maps %d attempts without agent lookup scans", (count) => {
    const base = control();
    const attempts = Array.from({ length: count }, (_, index) => ({ ...base.attempts[0]!, id: `attempt-${index}`, sequence: index + 1 }));
    const projected = flattenWorkflowView({ ...base, attempts }, flattened.agents);
    expect(projected.attempts).toHaveLength(count);
    expect(projected.cursor).toBe(0);
  });
});

describe("the whole plan in the workflow view", () => {
  /** Run the next ready attempt to success with `handoff`. */
  function succeedNext(committed: CommittedWorkflowControl, handoff: { readonly [key: string]: unknown }): CommittedWorkflowControl {
    const prepared = prepareExecution(committed).control;
    const next = prepared.attempts.find(({ state }) => state._tag === "pending");
    if (!next) throw new Error("no pending attempt");
    const started = startExecution(prepared, next.id, `conversation-${next.id}`).control;
    return completeAttempt(started, {
      type: "ATTEMPT_SUCCEEDED",
      outcome: { attemptId: next.id, conversationId: `conversation-${next.id}`, handoff, reassessment: null },
    }).committed;
  }

  function compiled(phases: readonly unknown[]) {
    const { workflow, agents } = plan(phases);
    return { launch: compileWorkflowControl(workflow, agents, { skills }), agents };
  }

  const shown = (committed: CommittedWorkflowControl, agents: ReadonlyMap<string, ResolvedAgent>): string[] =>
    flattenWorkflowView(committed, agents).tree.nodes.flatMap((node) => node.kind === "agent" ? [`${node.definitionId}:${node.disposition}`] : []);

  it("shows a phase with if as if needed from launch and resolves it from the handoff it reads", () => {
    const { launch, agents } = compiled([
      phase("linear", { output: { summary: "Linear.", fields: { hypothesis: field("The cause.") } } }),
      phase("work", { if: "linear.hypothesis" }),
      phase("review", { if: "work" }),
    ]);
    expect(flattenWorkflowView(launch, agents).tree.nodes.map(({ kind }) => kind)).toEqual(["phase", "agent", "phase", "agent", "phase", "agent"]);
    expect(shown(launch, agents)).toEqual(["linear:pending", "work:conditional", "review:conditional"]);
    const accepted = succeedNext(launch, { hypothesis: "cause" });
    expect(shown(accepted, agents)).toEqual(["linear:completed", "work:pending", "review:conditional"]);
    expect(flattenWorkflowView(startNext(accepted), agents).tree.currentAgentNodeId).toBe(launch.graph.nodes[1]!.id);
    expect(shown(succeedNext(accepted, {}), agents)).toEqual(["linear:completed", "work:completed", "review:pending"]);
    expect(shown(succeedNext(launch, {}), agents)).toEqual(["linear:completed", "work:skipped", "review:skipped"]);
    // A failed workflow runs nothing more, so nothing it planned stays "if needed".
    expect(shown({ ...launch, status: "failed" }, agents)).toEqual(["linear:pending", "work:skipped", "review:skipped"]);
  });

  it("marks the phases of a round after its while phase if needed until that phase decides", () => {
    const { launch, agents } = compiled([
      phase("linear"),
      { repeat: { while: "review.findings", max: 3 }, phases: [phase("review", { output: { summary: "Review.", fields: { findings: { type: "list", optional: true, description: "Open findings.", of: { type: "object", fields: { id: { type: "string", description: "Id." } } } } } } }), phase("work")] },
    ]);
    // Each agent shows the round of the check that it leads to: the work
    // after a review repairs for the next review, and round 1 has no label.
    const labelled = (committed: CommittedWorkflowControl): string[] => {
      const nodes = flattenWorkflowView(committed, agents).tree.nodes;
      return nodes.flatMap((node) => {
        if (node.kind !== "agent") return [];
        const parent = nodes.find(({ id }) => id === node.parentId);
        const round = parent?.kind === "phase" ? parent.round?.number : undefined;
        return [`${node.definitionId}${round === undefined ? "" : ` · round ${round}`}:${node.disposition}`];
      });
    };
    const loop = (committed: CommittedWorkflowControl) => flattenWorkflowView(committed, agents).tree.nodes.find(({ kind }) => kind === "repeat");
    expect(labelled(launch)).toEqual(["linear:pending", "review:pending", "work · round 2:conditional"]);
    const reviewed = succeedNext(succeedNext(launch, {}), { findings: [{ id: "one" }] });
    expect(labelled(reviewed)).toEqual(["linear:completed", "review:completed", "work · round 2:pending"]);
    // The header counts the round of the queued work, which is current.
    expect(loop(reviewed)).toMatchObject({ loop: { iteration: 2, maxIterations: 3 } });
    const second = succeedNext(reviewed, {});
    expect(labelled(second)).toEqual(["linear:completed", "review:completed", "work · round 2:completed", "review · round 2:pending", "work · round 3:conditional"]);
    // A dry review stops the repeat, so the work of the next round is skipped.
    const settled = succeedNext(second, {});
    expect(labelled(settled)).toEqual(["linear:completed", "review:completed", "work · round 2:completed", "review · round 2:completed", "work · round 3:skipped"]);
    expect(loop(settled)).toMatchObject({ loop: { iteration: 2, maxIterations: 3, outcome: "dry" } });
    expect(labelled(succeedNext(succeedNext(launch, {}), {}))).toEqual(["linear:completed", "review:completed", "work · round 2:skipped"]);
    // The last round ends on its review: no work waits after it, and the
    // repeat stops there with findings still open.
    const third = succeedNext(succeedNext(second, { findings: [{ id: "two" }] }), {});
    expect(labelled(third)).toEqual(["linear:completed", "review:completed", "work · round 2:completed", "review · round 2:completed", "work · round 3:completed", "review · round 3:pending"]);
    const bounded = succeedNext(third, { findings: [{ id: "three" }] });
    expect(bounded.status).toBe("completed");
    expect(labelled(bounded)).toEqual(["linear:completed", "review:completed", "work · round 2:completed", "review · round 2:completed", "work · round 3:completed", "review · round 3:completed"]);
    expect(loop(bounded)).toMatchObject({ loop: { iteration: 3, maxIterations: 3, outcome: "bound" } });
  });

  it("plans the rounds of a repeat over items from the round that runs", () => {
    const { launch, agents } = compiled([
      phase("linear", { output: { summary: "Linear.", fields: { items: requiredList } } }),
      { repeat: { each: "linear.items" }, phases: [phase("work"), phase("review"), phase("check")] },
    ]);
    expect(shown(launch, agents)).toEqual(["linear:pending", "work:pending", "review:pending", "check:pending"]);
    const expanded = succeedNext(launch, { items: [{ id: "a" }, { id: "b" }] });
    expect(shown(expanded, agents)).toEqual(["linear:completed", "work:pending", "review:pending", "check:pending", "work:pending", "review:pending", "check:pending"]);
    const staged = succeedNext(succeedNext(expanded, {}), {});
    expect(shown(staged, agents)).toEqual(["linear:completed", "work:completed", "review:completed", "check:pending", "work:pending", "review:pending", "check:pending"]);
    expect(shown({ ...staged, status: "failed" }, agents)).toEqual(["linear:completed", "work:completed", "review:completed", "check:pending", "work:skipped", "review:skipped", "check:skipped"]);
    const tree = flattenWorkflowView(staged, agents).tree;
    expect(tree.nodes.flatMap((node) => node.kind === "phase" && node.round !== undefined ? [node.round.number] : [])).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("collapses retry lineage but keeps repeated authored positions as distinct agents", () => {
    const { launch, agents } = compiled([phase("work", { retry: { max: 2, stuck: false } }), { phase: "again", runs: "work", writes: [] }, phase("review")]);
    // A build before phases ran the later phases as a `then` chain of one node.
    const chain = asThenChain(launch);
    const started = startNext(chain);
    const attempt = started.attempts[0]!;
    const retried = failAttempt(started, { type: "ATTEMPT_FAILED", failure: { attemptId: attempt.id, kind: "invalid_handoff", reason: "missing summary", conversationId: attempt.conversationId!, content: {}, issues: [] } }).committed;
    const finished = drive(retried, () => ({ handoff: { summary: "done" } }));
    const tree = flattenWorkflowView(finished, agents).tree;
    const agentNodes = tree.nodes.filter((node) => node.kind === "agent");
    expect(agentNodes.map((node) => node.definitionId)).toEqual(["work", "again", "review"]);
    expect(agentNodes.map(({ attempts }) => attempts)).toEqual([2, 1, 1]);
    expect(agentNodes[0]).toMatchObject({ id: attempt.id, currentAttemptId: retried.attempts[1]!.id, disposition: "completed" });
  });

  it.each([
    { stuck: true, outcome: "stuck", rounds: 2 },
    { stuck: false, outcome: "bound", rounds: 3 },
  ])("projects the production $outcome stop decision", ({ stuck, outcome, rounds }) => {
    const { launch, agents } = compiled([{ repeat: { while: "review.findings", max: 3, stuck }, phases: [phase("review", { output: { summary: "Review.", fields: { findings: { type: "list", optional: true, description: "Open findings.", of: { type: "object", fields: { id: { type: "string", description: "Id." } } } } } } }), phase("work")] }]);
    const finished = drive(launch, () => ({ handoff: { findings: [{ id: "same" }] } }));
    const tree = flattenWorkflowView(finished, agents).tree;
    expect(tree.nodes[0]).toMatchObject({ kind: "repeat", loop: { iteration: rounds, maxIterations: 3, outcome } });
    expect(tree.nodes.filter(({ disposition }) => disposition === "conditional")).toEqual([]);
  });

  it("skips the phases after a failed agent that read it while independent work runs", () => {
    const { launch, agents } = compiled([
      { phase: "fork", agents: [{ agent: "work", ...phase("work") }, { agent: "other", ...phase("other") }] },
      phase("review", { if: "work" }),
    ]);
    let running = startNext(launch);
    const source = running.attempts[0]!;
    running = failAttempt(running, { type: "ATTEMPT_FAILED", failure: { attemptId: source.id, kind: "invalid_handoff", reason: "source failed", conversationId: source.conversationId!, content: {}, issues: [] } }).committed;
    running = startNext(running);
    expect(running.status).toBe("executing");
    const tree = flattenWorkflowView(running, agents).tree;
    expect(tree.nodes.map(({ kind, disposition }) => [kind, disposition])).toEqual([["phase", "running"], ["agent", "failed"], ["agent", "running"], ["phase", "conditional"], ["agent", "conditional"]]);
  });
});

describe("the operational tree of a workflow with a phase or a list", () => {
  const historyAgents = testResolvedAgents(["source", "a", "b", "c"].map((id) => testResolvedAgent(id, testSkill(id))));
  const historyTree = (root: unknown) => projectTree(replayWorkflowControl([parseWorkflowSessionFact(root)]), (id) => historyAgents.get(id)!.name);
  const workflowTree = (committed: CommittedWorkflowControl) => projectTree(committed, (id) => mapBindings.get(id)!.name);
  const nodeOf = (committed: CommittedWorkflowControl, id: string) => workflowTree(committed).nodes.find((node) => node.id === id);
  /** Each agent, and each phase of a list that has not read its items. */
  const shownMap = (committed: CommittedWorkflowControl) =>
    flattenWorkflowView(committed, mapBindings).tree.nodes.flatMap((node) => node.kind === "agent" ? [`${node.definitionId}:${node.disposition}`] : node.kind === "phase" && node.list?.expanded === false ? [`${node.phaseId}:${node.disposition}`] : []);

  // The parallel phases below exist only in control from before phases,
  // whose entries could run beside each other with `after`.
  it("makes only the span that runs beside itself a parallel phase between single phases of control from before phases", () => {
    const tree = historyTree(arms.span.root);
    expect(tree.nodes.map(({ id, kind, parentId }) => [id, kind, parentId])).toEqual([
      ["span:node:1:phase", "phase", null], ["span:node:1", "agent", "span:node:1:phase"],
      ["span:node:2:span", "phase", null], ["span:node:2", "agent", "span:node:2:span"], ["span:node:3", "agent", "span:node:2:span"],
      ["span:node:4:phase", "phase", null], ["span:node:4", "agent", "span:node:4:phase"],
    ]);
    expect(tree.nodes[2]).toMatchObject({ kind: "phase", form: "parallel", label: "Parallel agents", disposition: "pending" });
  });

  it("makes the whole phase container of control from before phases one parallel phase even when some agents wait on others", () => {
    const tree = historyTree(arms.fork.root);
    expect(tree.nodes[0]).toMatchObject({ kind: "phase", form: "parallel" });
    expect(tree.nodes).toHaveLength(4);
    expect(tree.nodes[3]).toMatchObject({ waitsOn: ["fork:node:1:node:1"] });
  });

  it("makes no parallel phase when a later sibling puts the entries in total order", () => {
    expect(historyTree(arms.ordered.root).nodes.flatMap((node) => node.kind === "phase" ? [node.form] : [])).toEqual(["single", "single", "single"]);
  });

  it("gives a workflow of one-agent phases one single phase with its agent per phase and preserves its tree when restated", () => {
    const { workflow, agents } = plan([phase("linear"), phase("work"), phase("review")]);
    const plain = compileWorkflowControl(workflow, agents, { skills });
    const flat = flattenWorkflowView(plain, agents);
    expect(flat.tree.nodes.map((node) => [node.kind, node.kind === "agent" ? node.definitionId : node.kind === "phase" ? node.form : null])).toEqual([
      ["phase", "single"], ["agent", "linear"], ["phase", "single"], ["agent", "work"], ["phase", "single"], ["agent", "review"],
    ]);
    expect(restateWorkflowView(flat, plain).tree).toEqual(flat.tree);
  });

  it("plans a list as one pending phase per phase of its stream before it reads its items, and gives each phase one agent per item after", () => {
    const launch = mapControl();
    expect(shownMap(launch)).toEqual(["plan:pending", "implement:pending", "review:pending", "tail:pending"]);
    expect(workflowTree(launch).nodes.map(({ id, kind, parentId }) => [id, kind, parentId])).toEqual([
      [`${PLAN}:phase`, "phase", null], [PLAN, "agent", `${PLAN}:phase`], [IMPLEMENT, "phase", null], [REVIEW, "phase", null], [`${TAIL}:phase`, "phase", null], [TAIL, "agent", `${TAIL}:phase`],
    ]);
    expect(nodeOf(launch, IMPLEMENT)).toMatchObject({ disposition: "pending", form: "list", phaseId: "implement", list: { id: MAP_GROUP, expanded: false } });
    expect(nodeOf(launch, REVIEW)).not.toHaveProperty("join");
    // A workflow that can no longer run plans nothing it would wait for.
    expect(shownMap({ ...launch, status: "failed" })).toEqual(["plan:pending", "implement:skipped", "review:skipped", "tail:pending"]);

    const expanded = drive(launch, mapOutcome(items("a", "b")), (committed) => committed.graph.nodes.some(({ kind }) => kind === "item"));
    expect(shownMap(expanded)).toEqual(["plan:completed", "implement:pending", "implement:pending", "review:pending", "review:pending", "tail:pending"]);
    expect(nodeOf(expanded, stage(2, 1))).toMatchObject({ kind: "agent", label: "Implement", parentId: IMPLEMENT, attempts: 1, currentAttemptId: attemptOf(stage(2, 1)), item: { nodeId: branch(2), key: "b", label: "Item b", ordinal: 2, text: '{"id":"b","title":"Item b"}' } });
    expect(nodeOf(expanded, stage(2, 2))).toMatchObject({ kind: "agent", label: "Review", parentId: REVIEW, item: { nodeId: branch(2), key: "b" } });
    // Only the last phase of a stream holds its join.
    expect(nodeOf(expanded, IMPLEMENT)).not.toHaveProperty("join");
    expect(nodeOf(expanded, REVIEW)).toMatchObject({ join: { reducer: "collect@1", state: "pending", slots: 2, completed: 0, failed: 0, pending: 2, missing: 0 } });
    expect(workflowTree(expanded).currentAgentNodeId).toBe(stage(1, 1));
  });

  it("shows a failed item with its reason while its siblings continue, and a settled join that names every slot", () => {
    const failing = new Set([attemptOf(stage(2, 1))]);
    const midway = drive(mapControl(), mapOutcome(items("a", "b", "c"), failing), (committed) => committed.attempts.some(({ state }) => state._tag === "failed"));
    expect(nodeOf(midway, stage(2, 1))).toMatchObject({ disposition: "failed", reason: "summary is required" });
    expect(nodeOf(midway, stage(2, 2))).toMatchObject({ disposition: "skipped" });
    // A completed agent carries its handoff summary; a failed one carries none.
    expect(nodeOf(midway, stage(1, 2))).toMatchObject({ evidence: { summary: "done" } });
    expect(nodeOf(midway, stage(2, 1))).not.toHaveProperty("evidence");
    expect(nodeOf(midway, PLAN)).toMatchObject({ evidence: { summary: "The plan" } });
    // The sibling holds unfinished work and continues.
    expect(nodeOf(midway, IMPLEMENT)?.disposition).toBe("running");
    expect(nodeOf(midway, REVIEW)).toMatchObject({ disposition: "running", join: { state: "pending", slots: 3, completed: 1, failed: 1, pending: 1, missing: 0 } });

    const settled = drive(midway, mapOutcome(items("a", "b", "c"), failing));
    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect(settled.status).toBe("failed");
    expect(nodeOf(settled, REVIEW)).toMatchObject({ disposition: "completed", join: { state: "settled", slots: 3, completed: 2, failed: 1, pending: 0, missing: 0 } });
    expect(workflowTree(settled).currentAgentNodeId).toBeUndefined();
  });

  it("keeps the interrupted agent current and its phase unfinished in a paused tree", () => {
    const paused = interrupt(startNext(wideControl(3)));
    expect(paused.status).toBe("paused");
    const tree = workflowTree(paused);
    const agent = "input-mapped:node:1:item:1:phase:1";
    expect(tree.currentAgentNodeId).toBe(agent);
    expect(tree.nodes.find(({ id }) => id === agent)).toMatchObject({ disposition: "pending", attempts: 1 });
    expect(tree.nodes.filter(({ disposition }) => disposition === "completed")).toEqual([]);
    expect(tree.nodes.find(({ id }) => id === "input-mapped:node:1:phase:2")).toMatchObject({ join: { state: "pending", completed: 0, pending: 3 } });
  });

  it("projects an empty list as zero slots with no agent, pending until its join folds", () => {
    const launch = wideControl(0);
    const empty = { reducer: "collect@1", slots: 0, completed: 0, failed: 0, pending: 0, missing: 0 };
    const last = "input-mapped:node:1:phase:2";
    expect(workflowTree(launch).nodes.filter((node) => node.kind === "agent" && node.item !== undefined)).toEqual([]);
    expect(workflowTree(launch).nodes.find(({ id }) => id === last)).toMatchObject({ join: { ...empty, state: "pending" } });
    const folded = prepareExecution(launch).control;
    expect(workflowTree(folded).nodes.find(({ id }) => id === last)).toMatchObject({ disposition: "completed", join: { ...empty, state: "settled" } });
  });

  it("makes a phase of named agents a parallel phase, and phases of one agent single phases", () => {
    const forms = (committed: CommittedWorkflowControl) => workflowTree(committed).nodes.flatMap((node) => node.kind === "phase" ? [`${node.phaseId}:${node.form}`] : []);
    expect(forms(phaseControl(true))).toEqual(["build:parallel", "tail:single"]);
    expect(forms(phaseControl(false))).toEqual(["implement:single", "review:single", "tail:single"]);
  });

  it("projects about 85 items in manifest order, each with its own agents", () => {
    const tree = workflowTree(wideControl(85));
    const first = tree.nodes.flatMap((node) => node.kind === "agent" && node.parentId === "input-mapped:node:1:phase:1" ? [node] : []);
    expect(first).toHaveLength(85);
    expect(first.map(({ item }) => item?.ordinal)).toEqual(Array.from({ length: 85 }, (_, index) => index + 1));
    // Two phases of 85 agents each, and the single phase of the tail with its agent.
    expect(tree.nodes).toHaveLength(2 + 85 * 2 + 2);
    expect(tree.nodes.find(({ id }) => id === "input-mapped:node:1:phase:2")).toMatchObject({ join: { slots: 85, pending: 85 } });
  });
});
