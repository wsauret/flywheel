interface StoredOutput {
  readonly [key: string]: unknown;
}

/** Render a stored agent output for the context of a later agent.
 *
 *  The payload is shown as stored and never decoded again: the writer's
 *  boundary already validated it, and a payload that an older contract wrote
 *  must still reach the next agent whole. `### Summary` comes first, then the
 *  keys in `fieldOrder` (the writer's current contract order), then every
 *  remaining key in stored order, so historical fields stay visible. */
export function renderAgentOutput(payload: StoredOutput, fieldOrder: readonly string[]): string {
  const keys = ["summary", ...fieldOrder, ...Object.keys(payload)].filter((key) => Object.hasOwn(payload, key) && payload[key] !== undefined);
  return [...new Set(keys)].map((key) => `### ${fieldHeading(key)}\n${renderValue(key, payload[key])}`).join("\n\n");
}

function fieldHeading(key: string): string {
  return key.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function renderValue(key: string, value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (isStringList(value)) return value.map((item) => `- ${item}`).join("\n");
  if (key === "commands_run" && isCommandRunList(value)) return value.map(renderCommandRun).join("\n");
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

interface CommandRun {
  readonly command: string;
  readonly exitCode?: unknown;
  readonly cwd?: unknown;
  readonly changedAfter?: unknown;
  readonly observation?: unknown;
}

const LISTED_CHANGES = 5;

function isCommandRunList(value: unknown): value is readonly CommandRun[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === "object" && item !== null && "command" in item && typeof item.command === "string");
}

/** A record stored before the directory and later changes were recorded
 *  lacks both keys, and renders without them. */
function renderCommandRun(run: CommandRun): string {
  const cwd = typeof run.cwd === "string" ? ` in ${run.cwd}` : "";
  const exit = typeof run.exitCode === "number" ? ` (exit ${run.exitCode}${renderChangedAfter(run.changedAfter)})` : "";
  const observation = typeof run.observation === "string" ? `: ${run.observation}` : "";
  return `- \`${run.command}\`${cwd}${exit}${observation}`;
}

function renderChangedAfter(changedAfter: unknown): string {
  if (!isStringList(changedAfter)) return "";
  const more = changedAfter.length - LISTED_CHANGES;
  return `; files changed after this run: ${changedAfter.slice(0, LISTED_CHANGES).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}
