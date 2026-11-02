import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { verifyAuthoredWorkflow, verifyInstantiatedWorkflow } from "../../../../src/workflows/vm/verify.js";
import { DRY_LOOP, dryRound, dryWorkflow, INPUT_GROUP, inputMapWorkflow, mapSkills, mapWorkflow, VOTES_CHECKS, votesWorkflow } from "./_map-fixtures.js";

const skills = testSkillRevision([]);
const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id });

function compiled(phases: readonly unknown[]): CommittedWorkflowControl {
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "instantiated", name: "Instantiated", phases });
  return compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills });
}

function control(): CommittedWorkflowControl {
  return compiled(["one", "two", "three"].map((id) => ({ phase: id, ...record(id) })));
}

/** Real compiled control of a phase of named agents: phase "build" holds
 *  agents one and two, and phase three runs after it. */
function phaseControl(): CommittedWorkflowControl {
  return compiled([
    { phase: "build", agents: [{ agent: "one", ...record("one") }, { agent: "two", ...record("two") }] },
    { phase: "three", ...record("three") },
  ]);
}

/** Verify a defect injected into typed compiled control. */
function verifyControl(injected: CommittedWorkflowControl): ReturnType<typeof verifyInstantiatedWorkflow> {
  return verifyInstantiatedWorkflow(injected);
}

function defectNames(report: ReturnType<typeof verifyInstantiatedWorkflow>): string[] {
  expect(report.result).toBe("invalid");
  return report.findings.map(({ name }) => name);
}

describe("instantiated workflow defect verification", () => {
  it("accepts a valid concrete control and reaches a terminal witness", () => {
    const report = verifyInstantiatedWorkflow(control());
    expect(["proved", "partially_proved"]).toContain(report.result);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "terminal_reachable", target: "completed" }),
    ]));
    expect(report.findings.find(({ name, target }) => name === "terminal_reachable" && target === "completed")?.witness)
      .toEqual(expect.arrayContaining(["ATTEMPT_STARTED", "COMMIT_SUCCEEDED"]));
  });

  it("detects unreachable work", () => {
    const base = control();
    const target = base.graph.nodes[1]?.id;
    if (!target) throw new Error("fixture target missing");
    const report = verifyControl({
      ...base,
      attempts: base.attempts.filter(({ logicalNodeId }) => logicalNodeId !== target),
      guardrails: {
        ...base.guardrails,
        attemptMutationsUsed: base.guardrails.attemptMutationsUsed.filter(({ attemptId }) =>
          base.attempts.find((attempt) => attempt.id === attemptId)?.logicalNodeId !== target
        ),
      },
    });
    expect(defectNames(report)).toContain("unreachable_work");
    expect(report.findings).toContainEqual(expect.objectContaining({ target }));
  });

  it("detects a join that no list can fold", () => {
    const base = control();
    const required = base.graph.nodes[0];
    const target = base.graph.nodes[1];
    if (!required || !target) throw new Error("fixture nodes missing");
    const report = verifyControl({
      ...base,
      graph: {
        ...base.graph,
        joins: [{ kind: "collect_all", nodeId: target.id, requiredNodeIds: [required.id] }],
      },
    });
    expect(defectNames(report)).toContain("impossible_join");
    expect(report.findings).toContainEqual(expect.objectContaining({ target: target.id }));
  });

  it("detects unbounded and falsely bounded dependency cycles", () => {
    const base = control();
    const first = base.graph.nodes[0];
    const second = base.graph.nodes[1];
    if (!first || !second) throw new Error("fixture nodes missing");
    const cycleDependency = { nodeId: first.id, dependsOn: second.id };
    const cycleBack = { nodeId: second.id, dependsOn: first.id };
    const unbounded = verifyControl({
      ...base,
      graph: { ...base.graph, dependencies: [cycleDependency, cycleBack] },
    });
    expect(defectNames(unbounded)).toContain("dependency_cycle");
    expect(unbounded.findings.find(({ name }) => name === "dependency_cycle")?.message)
      .toContain(`${first.id} -> ${second.id} -> ${first.id}`);

    const falselyBounded = verifyControl({
      ...base,
      graph: {
        ...base.graph,
        nodes: base.graph.nodes.map((node, index) => index === 0 ? {
          kind: "while",
          id: node.id,
          workflowDefinitionId: node.workflowDefinitionId,
          order: node.order,
          ownership: node.ownership,
          state: node.state,
          evaluator: { step: "one", field: "continue" },
          body: [{ step: "one" }],
          maxIterations: 2,
          detectStuck: true,
          iteration: 1,
          priorNormalizedSignal: null,
        } : node),
        dependencies: [cycleDependency, cycleBack],
      },
    });
    expect(defectNames(falselyBounded)).toContain("dependency_cycle");
    expect(falselyBounded.findings.find(({ name }) => name === "dependency_cycle")?.message).toContain("while");
  });

  it("detects invalid dependency targets, and follow-up targets of control from before phases", () => {
    const base = control();
    const first = base.graph.nodes[0];
    if (!first || first.kind !== "agent") throw new Error("fixture agent missing");
    const report = verifyControl({
      ...base,
      graph: {
        ...base.graph,
        nodes: [{ ...first, followUpV10: { step: "missing-step", when: null, then: null } }, ...base.graph.nodes.slice(1)],
        dependencies: [...base.graph.dependencies, { nodeId: first.id, dependsOn: "missing-node" }],
      },
    });
    expect(defectNames(report)).toEqual(expect.arrayContaining(["invalid_dependency_target", "invalid_then_target"]));
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "missing-node" }),
      expect.objectContaining({ target: "missing-step" }),
    ]));
  });

  it("detects missing ownership and invalid parent ownership", () => {
    const base = control();
    const first = base.graph.nodes[0];
    const second = base.graph.nodes[1];
    if (!first || !second) throw new Error("fixture nodes missing");
    const { ownership: _ownership, ...unowned } = first;
    const missing = verifyInstantiatedWorkflow({
      ...base,
      graph: { ...base.graph, nodes: [unowned, ...base.graph.nodes.slice(1)] },
    });
    expect(defectNames(missing)).toContain("missing_ownership");
    expect(missing.findings).toContainEqual(expect.objectContaining({ target: first.id }));

    const phased = phaseControl();
    const [phase, child, , last] = phased.graph.nodes;
    if (phase?.kind !== "phase" || child?.ownership._tag !== "phase" || !last) throw new Error("phase fixture missing");
    expect(verifyInstantiatedWorkflow(phased).result).not.toBe("invalid");
    const invalidParent = verifyControl({
      ...phased,
      graph: {
        ...phased.graph,
        nodes: phased.graph.nodes.map((node) => node.id === child.id
          ? { ...node, ownership: { ...child.ownership, parentNodeId: last.id } }
          : node),
      },
    });
    expect(defectNames(invalidParent)).toContain("invalid_parent_ownership");
    expect(invalidParent.findings).toContainEqual(expect.objectContaining({ name: "invalid_parent_ownership", target: child.id }));

    const attemptOnContainer = verifyControl({
      ...phased,
      attempts: phased.attempts.map((attempt) => attempt.logicalNodeId === child.id
        ? { ...attempt, logicalNodeId: phase.id, ownership: phase.ownership }
        : attempt),
    });
    expect(attemptOnContainer.findings).toContainEqual(expect.objectContaining({ name: "invalid_parent_ownership", target: phased.attempts[0]?.id }));
  });

  // Only a phase container of control from before phases declared limits.
  it("detects parent budget overruns against declared limits", () => {
    const phased = phaseControl();
    const phase = phased.graph.nodes[0];
    if (phase?.kind !== "phase") throw new Error("phase fixture missing");
    expect(phased.graph.budgets).toBeUndefined();
    const report = verifyControl({
      ...phased,
      graph: { ...phased.graph, budgets: [{ parentNodeId: phase.id, limits: { nodes: 1 } }] },
    });
    expect(defectNames(report)).toContain("parent_budget_overrun");
    expect(report.findings).toContainEqual(expect.objectContaining({ name: "parent_budget_overrun", target: phase.id, witness: [] }));

    const nested = verifyControl({
      ...phased,
      graph: {
        ...phased.graph,
        nodes: phased.graph.nodes.map((node) => node.id === `${phase.id}:node:1` ? {
          kind: "phase", id: node.id, workflowDefinitionId: node.workflowDefinitionId, order: node.order,
          ownership: node.ownership, state: node.state, phaseId: "inner", name: "inner", condition: null, join: null,
        } : node),
        budgets: [{ parentNodeId: phase.id, limits: { depth: 1 } }],
      },
      attempts: phased.attempts.filter(({ logicalNodeId }) => logicalNodeId !== `${phase.id}:node:1`),
    });
    expect(nested.findings).toContainEqual(expect.objectContaining({ name: "parent_budget_overrun", target: phase.id }));
  });

  it("detects queued attempts past the attempt limit", () => {
    const base = control();
    const report = verifyControl({ ...base, guardrails: { ...base.guardrails, maxAttempts: 2 } });
    expect(defectNames(report)).toContain("attempt_limit_overrun");
  });

  it("detects a repeat that holds more rounds than its bound", () => {
    const definition = dryWorkflow(1);
    const base = compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills: mapSkills });
    expect(verifyControl(base).findings.map(({ name }) => name)).not.toContain("while_bound_exceeded");
    const first = base.graph.nodes.find(({ id }) => id === dryRound(1));
    if (first?.kind !== "list") throw new Error("Expected round 1");
    const second = { ...first, id: dryRound(2), order: first.order + 1, ownership: { _tag: "round" as const, workflowDefinitionId: definition.id, parentNodeId: DRY_LOOP, round: 2 } };
    const nodes = [...base.graph.nodes.slice(0, first.order + 1), second, ...base.graph.nodes.slice(first.order + 1).map((node) => ({ ...node, order: node.order + 1 }))];
    expect(defectNames(verifyControl({ ...base, graph: { ...base.graph, nodes } }))).toContain("while_bound_exceeded");
  });

  it("verifies a compiled list over 0, 1, and 2 synthetic items without a defect", () => {
    const report = verifyInstantiatedWorkflow(compileWorkflowControl(mapWorkflow, resolveWorkflowAgents(mapWorkflow), { skills: mapSkills }));
    expect(report.result).toBe("partially_proved");
    // A failed plan agent blocks the list and the tail that need it, so the
    // run can fail as well as complete.
    expect(report.findings.map(({ name, target }) => [name, target])).toEqual([["terminal_reachable", "completed"], ["terminal_reachable", "failed"]]);
    expect(report.uncertainties.map(({ name }) => name)).toContain("runtime_map_width");
  });

  it("verifies a list with votes over sampled items, with every vote of each item as its own item", () => {
    const report = verifyAuthoredWorkflow(votesWorkflow, resolveWorkflowAgents(votesWorkflow), { skills: mapSkills });
    expect(report.result).toBe("partially_proved");
    expect(report.findings.map(({ name, target }) => [name, target])).toEqual([["terminal_reachable", "completed"], ["terminal_reachable", "failed"]]);
    expect(report.uncertainties).toContainEqual(expect.objectContaining({
      name: "runtime_map_width",
      target: VOTES_CHECKS,
      detail: expect.stringContaining("with 3 votes on each item"),
    }));
    expect(report.uncertainties).toContainEqual(expect.objectContaining({ name: "sampled_branch_outcomes", target: VOTES_CHECKS }));
  });

  it("verifies a list over the launch input with a sampled launch of two items", () => {
    const report = verifyAuthoredWorkflow(inputMapWorkflow, resolveWorkflowAgents(inputMapWorkflow), { skills: mapSkills });
    expect(report.result).toBe("partially_proved");
    // A failed tail agent fails the run, because the parent reads its output.
    expect(report.findings.map(({ name, target }) => [name, target])).toEqual([["terminal_reachable", "completed"], ["terminal_reachable", "failed"]]);
    expect(report.uncertainties).toContainEqual(expect.objectContaining({
      name: "runtime_map_width",
      target: INPUT_GROUP,
      detail: expect.stringContaining("a launch input of 2 items"),
    }));
  });
});
