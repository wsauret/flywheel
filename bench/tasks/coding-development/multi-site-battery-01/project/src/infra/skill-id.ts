/** Identity of one skill in the catalog.
 *
 *  A qualified skill id is `segment(.segment)*`, where each segment is a
 *  lowercase slug of letters, digits, and hyphens. Built-in slash tokens and
 *  the `learned` command root are reserved because user-invocable skills share
 *  their command namespace. One valid id names one skill wherever the id is
 *  written: a package directory, a workflow reference, a model tool argument,
 *  a slash command, or a definition-scoped model assignment selector. Every
 *  one of those boundaries validates through this module, so an id a skill can
 *  carry and an id a consumer accepts cannot drift apart. */

const SEGMENT = "[a-z0-9][a-z0-9-]*";

const QUALIFIED_SKILL_ID = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`, "u");

const LEARNED_SKILL_COMMAND_ROOT = "learned";
export const LEARNED_SKILL_COMMAND_PREFIX = `${LEARNED_SKILL_COMMAND_ROOT}.`;

/** Built-in slash tokens occupy the same user-facing namespace as bare skill
 *  commands, so no skill package can claim one of these ids. */
export const RESERVED_SKILL_IDS = [
  "new",
  "attach",
  "clear",
  "reset",
  "exit",
  "quit",
  "restart",
  "sessions",
  "changes",
  "resume",
  "model",
  "effort",
  "auth",
  "login",
  "profile",
  "theme",
  "settings",
  "config",
  "bg",
  "tasks",
  "fork",
  "compact",
  "reflect",
  "learn",
  "font",
  "status",
  "usage",
  "notifications",
  "find",
  "search",
  "shortcuts",
  "hotkeys",
  "keybindings",
  "help",
] as const;

const RESERVED_SKILL_ID_SET = new Set<string>(RESERVED_SKILL_IDS);

function usesLearnedSkillCommandRoot(value: string): boolean {
  return value === LEARNED_SKILL_COMMAND_ROOT || value.startsWith(LEARNED_SKILL_COMMAND_PREFIX);
}

/** Whether an id is a built-in slash command word or the learned-skill
 *  command root, which no skill or global workflow id can take. */
export function isReservedSkillId(value: string): boolean {
  return RESERVED_SKILL_ID_SET.has(value) || usesLearnedSkillCommandRoot(value);
}

export function isQualifiedSkillId(value: string): boolean {
  return QUALIFIED_SKILL_ID.test(value) && !isReservedSkillId(value);
}

/** Whether a qualified id can use this prefix. A command word may be a
 *  prefix without naming that command; the learned root reserves its whole
 *  namespace. */
export function isQualifiedSkillIdPrefix(value: string): boolean {
  return QUALIFIED_SKILL_ID.test(value) && !usesLearnedSkillCommandRoot(value);
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
  if (RESERVED_SKILL_ID_SET.has(id)) {
    throw new Error(`${subject} collides with built-in slash command: ${JSON.stringify(id)}`);
  }
  if (usesLearnedSkillCommandRoot(id)) {
    throw new Error(`${subject} uses reserved learned-skill command root: ${JSON.stringify(id)}`);
  }
  if (!isQualifiedSkillId(id)) {
    throw new Error(`${subject} must be a dot-delimited lowercase slug ([a-z0-9-]): ${JSON.stringify(id)}`);
  }
  return id;
}
