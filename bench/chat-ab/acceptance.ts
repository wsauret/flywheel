import { Schema } from "effect";

/** Acceptance scoring. Each task stores which of its frozen acceptance tests
 *  fail before the fix (fail-to-pass, F2P) and which already pass (the
 *  pass-to-pass guards, P2P). A cell's score is the fraction of F2P tests its
 *  change makes pass, less one F2P test for each guard it breaks. A guard that
 *  passes at baseline gives no credit, so an empty diff scores 0 and the shipped
 *  fix scores 1. A test is identified by its file and its full describe path. */

export type TestOutcome = "pass" | "fail";

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

const XML_ENTITIES = new Map([["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", "\""], ["&apos;", "'"]]);

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return XML_ENTITIES.get(entity) ?? entity;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
}

/** The name Bun (1.4.0 through 1.4.4) gives the test it reports for a beforeAll or afterAll
 *  hook that throws. The test belongs to the hook's scope: its file or describe. */
const HOOK_FAILURE = "(unnamed)";

/** Reads Bun's JUnit report (`bun test --reporter=junit`). Bun writes one
 *  outer suite per file, named by the file's path, and one nested suite per
 *  describe; a test's `classname` holds only part of that path, so the id is
 *  built from the suite nesting. A failed, skipped, or todo test fails: the
 *  acceptance suite is fixed, so a skip can only come from the agent's change.
 *  A throwing beforeAll or afterAll hook fails every test of its scope. Bun
 *  leaves out the tests of a file that does not load and of a throwing
 *  beforeAll, and those fail as unreported tests (classifyAcceptance). */
export function parseJUnitReport(xml: string): Map<string, TestOutcome> {
  const outcomes = new Map<string, TestOutcome>();
  const failedHookScopes: string[] = [];
  const suites: string[] = [];
  let open: string | undefined;
  const settle = (id: string, outcome: TestOutcome) => {
    if (id.endsWith(` > ${HOOK_FAILURE}`)) {
      if (outcome === "fail") failedHookScopes.push(id.slice(0, -HOOK_FAILURE.length));
      return;
    }
    if (outcomes.has(id)) throw new Error(`two acceptance tests share the id ${id}`);
    outcomes.set(id, outcome);
  };
  for (const [tag, closing, element, selfClosing] of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b[^>]*?(\/?)>/g)) {
    if (element === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attribute(tag, "name") ?? "");
    } else if (element === "testcase") {
      if (closing) {
        if (open !== undefined) settle(open, "pass");
        open = undefined;
        continue;
      }
      const id = [...suites, attribute(tag, "name") ?? ""].join(" > ");
      if (selfClosing) settle(id, "pass");
      else open = id;
    } else if (open !== undefined && !closing) {
      settle(open, "fail");
      open = undefined;
    }
  }
  for (const id of outcomes.keys()) {
    if (failedHookScopes.some((scope) => id.startsWith(scope))) outcomes.set(id, "fail");
  }
  return outcomes;
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
