/** Identity of one skill in the catalog.
 *
 *  A qualified skill id is `segment(.segment)*`, where each segment is a
 *  lowercase slug of letters, digits, and hyphens. One valid id names one
 *  skill wherever the id is written: a package directory, a workflow
 *  reference, a model tool argument, or a definition-scoped model assignment
 *  selector. Every one of those boundaries validates through this module, so an id a skill can
 *  carry and an id a consumer accepts cannot drift apart. */

const SEGMENT = "[a-z0-9][a-z0-9-]*";

const QUALIFIED_SKILL_ID = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`, "u");

export function isQualifiedSkillId(value: string): boolean {
  return QUALIFIED_SKILL_ID.test(value);
}

/** The id an untrusted caller named, or null when the value is not an id.
 *  Surrounding whitespace and letter case are model and keyboard noise, so they
 *  normalize away; anything else is not an id and is refused. */
export function normalizeSkillId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return isQualifiedSkillId(id) ? id : null;
}

/** The id itself, or a thrown refusal naming what carried it. For ids Flywheel
 *  owns, where a malformed id is a build bug or a misplaced definition file. */
export function requireQualifiedSkillId(id: string, subject: string): string {
  if (!isQualifiedSkillId(id)) {
    throw new Error(`${subject} must be a dot-delimited lowercase slug ([a-z0-9-]): ${JSON.stringify(id)}`);
  }
  return id;
}
