import { Schema } from "effect";

// The core-quality grade of an implementer cell (ARCH-DIRECTORIES-024). Each implementer task commits one tag per
// new hidden check in its `checks.json`: core (the use case the change was requested for), serious (a realistic
// failure that breaks the feature even when the normal path works), or edge (rare input, defensive handling, and
// packaging limits). A grader reports a pass or a fail for each check it ran, and this module alone turns those
// results into the grade, so no grader weighs its own checks.

const CHECK_TAGS = ["core", "serious", "edge"] as const;
export type CheckTag = typeof CHECK_TAGS[number];

const CheckTagsSchema = Schema.Record(Schema.String, Schema.Literals(CHECK_TAGS));
const decodeCheckTags = Schema.decodeUnknownSync(CheckTagsSchema);

/** Decode a task's `checks.json`: an object from each new check's id to its tag. A task with no core or serious
 *  check has nothing for quality to measure, so it fails here, at load. */
export function parseCheckTags(value: unknown, label: string): ReadonlyMap<string, CheckTag> {
  let tags: typeof CheckTagsSchema.Type;
  try {
    tags = decodeCheckTags(value);
  } catch {
    throw new Error(`${label} must map each check id to core, serious, or edge`);
  }
  const map = new Map(Object.entries(tags));
  if (![...map.values()].some((tag) => tag !== "edge")) throw new Error(`${label} tags no core or serious check`);
  return map;
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ShareSchema = Schema.Struct({ passed: Count, total: Count });

export const CheckGradeSchema = Schema.Struct({
  /** The new core and serious checks: the checks of the requested change that quality counts. */
  essential: ShareSchema,
  /** The existing tests that the change broke. Each one adds one failed check to quality; a passing one earns nothing. */
  broken: Count,
  /** The new edge checks, reported apart. They never enter quality. */
  edge: ShareSchema,
});
export type CheckGrade = typeof CheckGradeSchema.Type;

/** Grade one change from per-check results (true for a pass). A tagged check that the results do not hold failed:
 *  a build failure that ran no check scores no essential check. Every result whose id the tags do not name is an
 *  existing test of the task, which counts only when it fails. */
export function gradeChecks(tags: ReadonlyMap<string, CheckTag>, results: ReadonlyMap<string, boolean>): CheckGrade {
  const essential = { passed: 0, total: 0 };
  const edge = { passed: 0, total: 0 };
  for (const [id, tag] of tags) {
    const share = tag === "edge" ? edge : essential;
    share.total++;
    if (results.get(id) === true) share.passed++;
  }
  let broken = 0;
  for (const [id, passed] of results) if (!tags.has(id) && !passed) broken++;
  return { essential, broken, edge };
}

/** One line for a person: the essential checks passed over quality's denominator, the broken existing tests, and the
 *  edge checks passed. */
export function describeGrade(grade: CheckGrade): string {
  const broken = grade.broken > 0 ? ` with ${grade.broken} broken existing test${grade.broken === 1 ? "" : "s"}` : "";
  return `core quality ${grade.essential.passed}/${grade.essential.total + grade.broken}${broken}, edge ${grade.edge.passed}/${grade.edge.total}`;
}

/** The quality of a grade, from 0 to 1: the passed share of its essential checks, with each broken existing test
 *  counted as one more failed check. */
export function checkQuality(grade: CheckGrade): number {
  return grade.essential.passed / (grade.essential.total + grade.broken);
}

/** The grade fields of an implementer cell graded before 2026-11-26: pass and fail counts over every hidden test,
 *  with no tags. Local run stores and public records keep such cells as permanent history, so readers decode them,
 *  but no current grader writes them. */
export const LegacyAcceptanceFields = {
  acceptancePassed: Schema.Int,
  acceptanceFailed: Schema.Int,
  acceptanceTotal: Schema.Int,
};
type LegacyAcceptance = Schema.Struct<typeof LegacyAcceptanceFields>["Type"];

/** A graded change: its check grade, or the counts of a cell graded before the check tags. */
export type GradedChange = { readonly grade: CheckGrade } | LegacyAcceptance;

/** The share from 0 to 1 that a campaign report shows for one graded change: its quality, or the passed share of
 *  every hidden test for a cell graded before the check tags. */
export function gradedShare(change: GradedChange): number {
  return "grade" in change ? checkQuality(change.grade) : change.acceptancePassed / change.acceptanceTotal;
}
