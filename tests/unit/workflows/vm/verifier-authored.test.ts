import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, noSkills, workflowIn } from "../../../helpers/project-definitions.js";
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import {
  MAX_ATTEMPTS_CEILING,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "../../../../src/workflows/workflow-schema.js";
import { launchVerificationWarnings, parseWorkflowVerificationReport } from "../../../../src/workflows/vm/verify-types.js";
import { authoredGuardrailLimits, authoredStructureFindings, compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { verifyAuthoredWorkflow, verifyInstantiatedWorkflow } from "../../../../src/workflows/vm/verify.js";
import { DRY_LOOP, dryWorkflow, mapSkills } from "./_map-fixtures.js";

const skills = testSkillRevision([]);

/** A workflow of these phases and repeats. */
function workflow(phases: readonly unknown[], keys: { readonly [key: string]: unknown } = {}): WorkflowDefinition {
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "verified", name: "Verified", ...keys, phases });
}

/** One phase with an inline brief and these keys. */
const phase = (id: string, keys: { readonly [key: string]: unknown } = {}) => ({ phase: id, brief: `Do the ${id} work.`, name: id, ...keys });

/** An output whose `field` is a list of at most three items keyed by `id`. */
const listOutput = (field: string) => ({
  output: { fields: { [field]: { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } } } },
});

/** The resolved steps of one fixture definition. */
function resolved(definition: WorkflowDefinition): ReadonlyMap<string, ResolvedAgent> {
  return resolveWorkflowAgents(definition);
}

describe("authored workflow verification", () => {
  it("proves a phase of named agents and the phase after it", () => {
    const definition = workflow([{ phase: "build", agents: [{ agent: "left", ...phase("left") }, { agent: "right", ...phase("right") }] }, phase("ship")]);
    const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });
    expect(report.result).not.toBe("invalid");
    expect(report.findings).toContainEqual(expect.objectContaining({ name: "terminal_reachable", target: "completed" }));
  });

  it("judges the attempt limit as load-time validation does", () => {
    // Without a declaration, load and verify both judge against the ceiling,
    // so neither refuses a workflow that some launch setting can admit.
    const flow = workflow(["s0", "s1", "s2", "s3"].map((id) => phase(id)));
    expect(authoredGuardrailLimits(flow).maxAttempts).toBe(MAX_ATTEMPTS_CEILING);
    expect(authoredStructureFindings(flow, resolved(flow))).toEqual([]);

    const declared = { ...flow, guardrails: { max_attempts: 3 } };
    expect(authoredStructureFindings(declared, resolved(declared)).map(({ name }) => name)).toEqual(["attempt_limit_overrun"]);
    const report = verifyAuthoredWorkflow(declared, resolved(declared), { skills });
    expect(report.result).toBe("invalid");
    expect(report.findings.map(({ name }) => name)).toEqual(["attempt_limit_overrun"]);
  });

  it("judges a list of the launch input with the sampled launch, at load and in verification alike", () => {
    // A load has no launch, so the declared width of 40 is not the count:
    // each launch admits its exact items. Load and verify both judge one
    // sampled launch of two items: 2 x 2 phases and the tail queue 5.
    const inputWorkflow = (guardrails: { readonly max_attempts: number }) => workflow([
      phase("implement", { over: "input.items", retry: { max: 2, stuck: true } }),
      phase("review", { over: "implement", join: { reducer: "collect" } }),
      phase("tail"),
    ], {
      guardrails,
      input: { fields: { items: { type: "list", description: "The items.", max: 40, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } } } },
    });
    const verdicts = (definition: WorkflowDefinition) => {
      const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });
      return {
        load: authoredStructureFindings(definition, resolved(definition)).map(({ name }) => name),
        verify: report.result === "invalid" ? report.findings.map(({ name }) => name) : [],
      };
    };
    expect(verdicts(inputWorkflow({ max_attempts: 20 }))).toEqual({ load: [], verify: [] });
    const definition = inputWorkflow({ max_attempts: 20 });
    const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "terminal_reachable", target: "completed" }),
      expect.objectContaining({ name: "terminal_reachable", target: "failed" }),
      expect.objectContaining({ name: "retry_reachable" }),
    ]));
    expect(report.uncertainties).toContainEqual({
      name: "sampled_branch_outcomes",
      target: "verified:node:1",
      detail: "The verifier explores every outcome of the last unfinished item of this list, success or failure of the item before it, and only success for the other items; every item runs the same phases.",
    });
    expect(verdicts(inputWorkflow({ max_attempts: 5 }))).toEqual({ load: [], verify: [] });
    expect(verdicts(inputWorkflow({ max_attempts: 4 }))).toEqual({ load: ["attempt_limit_overrun"], verify: ["attempt_limit_overrun"] });
    // The count is the sample's, so the finding says so: an author who
    // declares it would see a full launch refused.
    const short = inputWorkflow({ max_attempts: 4 });
    const sampleNote = "This count gives each list of the launch input 2 sample items; a launch counts its real items, up to the max of each list.";
    expect(authoredStructureFindings(short, resolved(short)).map(({ message }) => message)).toEqual([`The workflow queues 5 attempts, more than its attempt limit of 4. ${sampleNote}`]);
    expect(verifyAuthoredWorkflow(short, resolved(short), { skills }).findings.map(({ message }) => message)).toEqual([`The workflow queues 5 attempts, more than its attempt limit of 4. ${sampleNote}`]);
  });

  it("explores a quorum join that groups its sampled items by an item field", () => {
    // A sampled item holds a synthetic key and label. The quorum reads its
    // group_by field from each item, so a sample must state that field too.
    const ballots = { type: "list", description: "The ballots.", max: 6, unique: "ballot", of: { type: "object", fields: { ballot: { type: "string", description: "The ballot id." }, finding: { type: "string", description: "The finding." } } } };
    const quorum = { reducer: "quorum", with: { vote: "vote", min_valid: 2, max_refuted: 1, group_by: "finding" } };
    const vote = { output: { fields: { vote: { type: "enum", values: ["valid", "refuted", "abstain"], description: "The vote." } } } };
    const definition = (source: "input" | "phase") => workflow([
      ...(source === "phase" ? [phase("listing", { output: { fields: { ballots } } })] : []),
      phase("votes", { over: source === "input" ? "input.ballots" : "listing.ballots", label: "ballot", ...vote, join: quorum }),
    ], source === "input" ? { input: { fields: { ballots } } } : {});

    for (const source of ["input", "phase"] as const) {
      const report = verifyAuthoredWorkflow(definition(source), resolved(definition(source)), { skills });
      const errors = report.findings.filter(({ witness }) => witness === null).map(({ name, message }) => `${name}: ${message}`);
      expect({ source, result: report.result, errors }).toEqual({ source, result: "partially_proved", errors: [] });
    }
  });

  it("reaches a phase that reads the output of a selecting join, as a run reaches it", () => {
    // Each synthetic agent of a join that a later phase reads reports the
    // reducer's entries, one or two, so the fold keeps them and the reader
    // runs; a quorum that needs two valid votes over the kept list passes.
    const findings = { type: "list", description: "The findings.", max: 3, unique: "site", of: { type: "object", fields: { site: { type: "string", description: "The site." }, score: { type: "number", description: "The score." } } } };
    const vote = { type: "enum", values: ["valid", "refuted", "abstain"], description: "The vote." };
    const named = (join: unknown) => ({ phase: "review", agents: ["a", "b"].map((agent) => ({ agent, ...phase(agent), output: { fields: { findings, vote } } })), join });
    const input = { input: listOutput("areas").output };
    const finds = phase("finds", { over: "input.areas", output: { fields: { findings } }, join: { reducer: "dedupe", with: { items: "findings", by: "site" } } });
    const cases = {
      "dedupe over named agents": workflow([named({ reducer: "dedupe", with: { items: "findings", by: "site" } }), phase("fix", { if: "review.kept" })]),
      "dedupe over a list": workflow([finds, phase("fix", { if: "finds.kept" })], input),
      "top over named agents": workflow([named({ reducer: "top", with: { items: "findings", by: "score", count: 2, order: "desc" } }), phase("fix", { if: "review.kept" })]),
      "quorum over named agents": workflow([named({ reducer: "quorum", with: { vote: "vote", min_valid: 1, max_refuted: 1 } }), phase("fix", { if: "review.passed" })]),
      "a list over a dedupe output": workflow([finds, phase("checks", { over: "finds.kept", label: "site" }), phase("after", { if: "checks.items" })], input),
      "a quorum of two votes over two kept items": workflow([
        named({ reducer: "dedupe", with: { items: "findings", by: "site" } }),
        phase("votes", { over: "review.kept", label: "site", output: { fields: { vote } }, join: { reducer: "quorum", with: { vote: "vote", min_valid: 2, max_refuted: 0 } } }),
        phase("fix", { if: "votes.passed" }),
      ]),
    };
    for (const [name, definition] of Object.entries(cases)) {
      const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });
      const defects = report.findings.filter(({ name: finding }) => finding !== "terminal_reachable" && finding !== "retry_reachable").map(({ name: finding, message }) => `${finding}: ${message}`);
      expect({ name, result: report.result, defects }).toEqual({ name, result: "partially_proved", defects: [] });
    }
  });

  it("strictly decodes honest report result states", () => {
    const partial = {
      result: "partially_proved",
      findings: [],
      uncertainties: [{ name: "runtime_handoff_values", target: null, detail: "Runtime data is not authored." }],
    } as const;
    expect(parseWorkflowVerificationReport(partial)).toEqual(partial);
    expect(() => parseWorkflowVerificationReport({ ...partial, uncertainties: [{ ...partial.uncertainties[0], name: "runtime_value" }] })).toThrow();
    expect(() => parseWorkflowVerificationReport({ ...partial, uncertainties: [] })).toThrow();
    expect(() => parseWorkflowVerificationReport({ ...partial, result: "unknown" })).toThrow();
    expect(() => parseWorkflowVerificationReport({ ...partial, extra: true })).toThrow();
    expect(() => parseWorkflowVerificationReport({
      result: "invalid",
      findings: [{ name: "defect", target: null, message: "bad", witness: null, noPathReason: null }],
      uncertainties: [],
    })).toThrow();
  });

  it("warns a launch about each defect and each uncertainty that the values of a run do not decide, and about nothing that the verifier proved", () => {
    const defect = { name: "unreachable_work", target: "flow", message: "No path reaches the node.", witness: [], noPathReason: null };
    const proof = { name: "terminal_reachable", target: "completed", message: "The production machine reaches completed.", witness: [], noPathReason: null };
    const limit = { name: "exploration_limit", target: null, message: "Exploration reached its bound.", witness: [], noPathReason: null };
    const runtime = { name: "runtime_map_width", target: "map", detail: "The run decides the width." } as const;
    const bounded = { name: "bounded_graph_exploration", target: null, detail: "The search stopped at its bound." } as const;

    expect(launchVerificationWarnings({ result: "proved", findings: [proof], uncertainties: [] })).toEqual({ findings: [], uncertainties: [] });
    expect(launchVerificationWarnings({ result: "partially_proved", findings: [proof], uncertainties: [runtime] })).toEqual({ findings: [], uncertainties: [] });
    expect(launchVerificationWarnings({ result: "partially_proved", findings: [limit], uncertainties: [runtime, bounded] })).toEqual({ findings: [], uncertainties: [bounded] });
    expect(launchVerificationWarnings({ result: "invalid", findings: [defect, proof, limit], uncertainties: [bounded] })).toEqual({ findings: [defect], uncertainties: [bounded] });
  });

  it("returns compiler failures as invalid reports instead of throwing", () => {
    const report = verifyAuthoredWorkflow(workflow([phase("missing")]), new Map(), { skills: noSkills });
    expect(report.result).toBe("invalid");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "compile_error", target: "verified", witness: null }),
    ]));
  });

  it("proves a reachable terminal and the authored while bound with event witnesses", () => {
    const definition = workflow([{
      repeat: { while: "review.findings", max: 3, stuck: true },
      phases: [phase("review", listOutput("findings")), phase("fix")],
    }]);
    const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });

    expect(report.result).toBe("partially_proved");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "terminal_reachable", target: "completed" }),
      expect.objectContaining({ name: "while_bound", target: "verified:node:1" }),
    ]));
    const terminal = report.findings.find(({ name, target }) => name === "terminal_reachable" && target === "completed");
    expect(terminal?.witness).toEqual(expect.arrayContaining(["INITIALIZE", "START", "ATTEMPT_STARTED"]));
    expect(report.uncertainties.every(({ name }) => name.length > 0)).toBe(true);
  });

  it("explores a repeat of a list to a dry round, and to its bound when the bound comes first", () => {
    // One item per round keeps the explored outcomes small: the round rules
    // under test do not depend on the item count.
    const verified = (maxIterations: number) => {
      const definition = dryWorkflow(maxIterations, false, 1);
      return verifyAuthoredWorkflow(definition, resolveWorkflowAgents(definition), { skills: mapSkills });
    };
    const reports = new Map([2, 3, 4].map((maxIterations) => [maxIterations, verified(maxIterations)] as const));
    const report = (maxIterations: number) => reports.get(maxIterations)!;
    for (const maxIterations of [2, 3]) {
      expect({ maxIterations, result: report(maxIterations).result, defects: report(maxIterations).findings.filter(({ witness }) => witness === null) }).toEqual({ maxIterations, result: "partially_proved", defects: [] });
      expect(report(maxIterations).uncertainties).toContainEqual({ name: "runtime_round_count", target: DRY_LOOP, detail: `The verifier reaches a dry round with synthetic items, and explores only the success of the agents of each round that it adds. The runtime round count is dynamic, up to ${maxIterations}. Structural admission counts ${maxIterations}.` });
    }
    // Every agent reports the same synthetic item, so round 1 keeps it and
    // round 2 is dry. A round 1 whose agents all failed is not dry, so round 2
    // keeps the item and round 3 is dry. Each added round explores only
    // success, so no later round keeps a new item: a bound of 2 or 3 is
    // reached, and a bound of 4 is not.
    for (const maxIterations of [2, 3]) expect(report(maxIterations).findings).toContainEqual(expect.objectContaining({ name: "while_bound", target: DRY_LOOP }));
    expect(report(4).findings.map(({ name }) => name)).not.toContain("while_bound");
  });

  it("explores repeats while a field holds items and over each item through the production machine", () => {
    const definition = workflow([
      phase("source", listOutput("items")),
      { repeat: { while: "review.findings", max: 2 }, phases: [phase("plan"), phase("review", listOutput("findings")), phase("fix")] },
      { repeat: { each: "source.items" }, phases: [phase("plan-each", { runs: "plan" }), phase("review-each", { runs: "review" }), phase("fix-each", { runs: "fix" })] },
    ]);
    const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });

    expect(report.result).toBe("partially_proved");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "terminal_reachable", target: "completed" }),
      expect.objectContaining({ name: "while_bound", target: "verified:node:2" }),
      expect.objectContaining({ name: "array_bounded_for", target: "verified:node:3" }),
    ]));
    expect(report.findings.some(({ name }) => name === "unreachable_work" || name === "machine_oracle_error")).toBe(false);

    // A repeat without reassess takes no reassess slot, so the compiled control alone states
    // the same uncertainties as the authored workflow.
    const control: CommittedWorkflowControl = compileWorkflowControl(definition, resolved(definition), { skills });
    const instantiated = verifyInstantiatedWorkflow(control);
    expect(instantiated.uncertainties.map(({ name }) => name)).toEqual(report.uncertainties.map(({ name }) => name));
    expect(instantiated.uncertainties.some(({ name }) => name === "model_reassessment_content")).toBe(false);
  });

  it("traverses bounded authored retries through the commit handshake", () => {
    const definition = workflow([phase("work", { retry: { max: 2, stuck: true } })]);
    const report = verifyAuthoredWorkflow(definition, resolved(definition), { skills });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "retry_reachable", target: "verified:node:1" }),
    ]));
    const retry = report.findings.find(({ name }) => name === "retry_reachable");
    expect(retry?.witness).toEqual(expect.arrayContaining(["ATTEMPT_STARTED", "ATTEMPT_FAILED", "COMMIT_SUCCEEDED"]));
  });

  it("verifies the fixture file with named dynamic uncertainty", () => {
    const definitions = fixtureDefinitions();
    const installed = definitions.skills();
    for (const definition of [workflowIn(definitions.captureRevision(), FIXTURE_WORKFLOW_ID)]) {
      const report = verifyAuthoredWorkflow(definition, resolveWorkflowAgents(definition), { skills: installed });
      expect(["proved", "partially_proved"]).toContain(report.result);
      if (report.result === "partially_proved") {
        expect(report.uncertainties.length).toBeGreaterThan(0);
        expect(report.uncertainties.every(({ name }) => name.length > 0)).toBe(true);
      }
      if (definition.phases.some((entry) => "repeat" in entry && "each" in entry.repeat)) {
        expect(report.findings).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "array_bounded_for" }),
        ]));
        expect(report.uncertainties).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "runtime_for_array_size" }),
        ]));
      }
    }
  }, 10_000);
});
