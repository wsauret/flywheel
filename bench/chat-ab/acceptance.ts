import { Schema } from "effect";
import type { TestOutcome } from "../../src/orchestration/modules/development/benchmark/implement-task/junit-report.js";

/** Acceptance scoring. Each task stores which of its frozen acceptance tests
 *  fail before the fix (fail-to-pass, F2P) and which already pass (the
 *  pass-to-pass guards, P2P). A cell's score is the fraction of F2P tests its
 *  change makes pass, less one F2P test for each guard it breaks. A guard that
 *  passes at baseline gives no credit, so an empty diff scores 0 and the shipped
 *  fix scores 1. A test is identified by its file and its full describe path. */

const TestOutcomeSchema = Schema.Literals(["pass", "fail"]);

const AcceptanceBaselineSchema = Schema.Struct({ failToPass: Schema.Array(Schema.String), passToPass: Schema.Array(Schema.String) });
export type AcceptanceBaseline = typeof AcceptanceBaselineSchema.Type;

/** The outcome of every baseline test in one run, grouped by its baseline set. */
export const AcceptanceRecordSchema = Schema.Struct({
  failToPass: Schema.Record(Schema.String, TestOutcomeSchema),
  passToPass: Schema.Record(Schema.String, TestOutcomeSchema),
});
export type AcceptanceRecord = typeof AcceptanceRecordSchema.Type;

const decodeBaseline = Schema.decodeUnknownSync(AcceptanceBaselineSchema, { onExcessProperty: "error" });

/** Decodes a task's stored baseline. At least one test must fail before the
 *  fix, or the task cannot score, and no test may be listed twice. */
export function parseAcceptanceBaseline(value: unknown, context: string): AcceptanceBaseline {
  const baseline = decodeBaseline(value);
  if (baseline.failToPass.length === 0) throw new Error(`${context} lists no test that fails before the fix`);
  const seen = new Set<string>();
  for (const id of [...baseline.failToPass, ...baseline.passToPass]) {
    if (seen.has(id)) throw new Error(`${context} lists ${id} twice`);
    seen.add(id);
  }
  return baseline;
}


/** The baseline an unfixed run defines: its failing tests are F2P and its passing tests are P2P. */
export function baselineOf(outcomes: ReadonlyMap<string, TestOutcome>): AcceptanceBaseline {
  const ids = (outcome: TestOutcome) => [...outcomes].flatMap(([id, value]) => value === outcome ? [id] : []).sort();
  const baseline = { failToPass: ids("fail"), passToPass: ids("pass") };
  if (baseline.failToPass.length === 0) throw new Error("no acceptance test fails before the fix, so the task cannot score a fix");
  return baseline;
}

/** Every way an unfixed run differs from the stored baseline; empty when it matches. */
export function baselineDrift(baseline: AcceptanceBaseline, outcomes: ReadonlyMap<string, TestOutcome>): string[] {
  const expected = new Map<string, TestOutcome>([...baseline.failToPass.map((id) => [id, "fail"] as const), ...baseline.passToPass.map((id) => [id, "pass"] as const)]);
  const drift: string[] = [];
  for (const id of [...new Set([...expected.keys(), ...outcomes.keys()])].sort()) {
    const [want, got] = [expected.get(id), outcomes.get(id)];
    if (want === undefined) drift.push(`${id} is not in the baseline`);
    else if (got === undefined) drift.push(`${id} did not run`);
    else if (want !== got) drift.push(`${id} ${got === "pass" ? "passes" : "fails"}, but the baseline lists it as ${want === "pass" ? "passing" : "failing"}`);
  }
  return drift;
}

/** Groups one run's outcomes by baseline set. A listed test the report left
 *  out fails, and a run that wrote no report (it timed out) fails every test:
 *  the acceptance directory is fixed, so only the agent's change can stop a
 *  test file from loading or the run from finishing. A reported test that the
 *  baseline does not list is a harness error, never a score. */
export function classifyAcceptance(baseline: AcceptanceBaseline, outcomes: ReadonlyMap<string, TestOutcome> | null): AcceptanceRecord {
  const listed = new Set([...baseline.failToPass, ...baseline.passToPass]);
  const unknown = [...outcomes?.keys() ?? []].filter((id) => !listed.has(id));
  if (unknown.length > 0) throw new Error(`the acceptance run reported tests that are not in the task's acceptance baseline: ${unknown.join(", ")}`);
  const group = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, outcomes?.get(id) ?? "fail"] as const));
  return { failToPass: group(baseline.failToPass), passToPass: group(baseline.passToPass) };
}

export interface AcceptanceScore {
  /** F2P tests that pass. */
  readonly fixed: number;
  /** The task's F2P tests. */
  readonly fixable: number;
  /** P2P tests that fail. */
  readonly brokenGuards: readonly string[];
  /** (fixed - broken guards) / fixable. It is not clamped at 0, so a change
   *  that breaks guards scores below an empty diff and the parity rule
   *  sees the whole lower tail. Clamp only for display. */
  readonly score: number;
  /** Every F2P and every P2P test passes. */
  readonly resolved: boolean;
}

export function scoreAcceptance(record: AcceptanceRecord): AcceptanceScore {
  const outcomes = Object.values(record.failToPass);
  const fixed = outcomes.filter((outcome) => outcome === "pass").length;
  const brokenGuards = Object.entries(record.passToPass).flatMap(([id, outcome]) => outcome === "fail" ? [id] : []);
  return { fixed, fixable: outcomes.length, brokenGuards, score: (fixed - brokenGuards.length) / outcomes.length, resolved: fixed === outcomes.length && brokenGuards.length === 0 };
}
