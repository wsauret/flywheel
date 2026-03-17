import * as yaml from "js-yaml";
import type { ParsedStateFile, ParsedPhase, ErrorLogEntry } from "./reader";
import { writeFileAtomic } from "../utils/atomic-write";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a ParsedStateFile back to markdown string.
 */
export function serializeStateFile(state: ParsedStateFile): string {
  const parts: string[] = [];

  // Frontmatter -- write controller metadata
  const fm = { ...state.frontmatter };
  fm.writer = "controller";
  fm.last_written_at = new Date().toISOString();

  parts.push("---");
  parts.push(
    yaml.dump(fm, { schema: yaml.JSON_SCHEMA, lineWidth: -1 }).trimEnd(),
  );
  parts.push("---");
  parts.push("");

  // Title
  if (state.title) {
    parts.push(`# Execution State: ${state.title}`);
    parts.push("");
  }

  // Progress
  parts.push("## Progress");
  for (let i = 0; i < state.phases.length; i++) {
    parts.push(serializePhase(i + 1, state.phases[i]));
  }
  parts.push("");

  // Key Decisions
  if (state.keyDecisions.length > 0) {
    parts.push("## Key Decisions");
    for (const decision of state.keyDecisions) {
      parts.push(`- ${decision}`);
    }
    parts.push("");
  }

  // Error Log
  parts.push("## Error Log");
  parts.push("| Error | Attempt | Approach | Outcome |");
  parts.push("|-------|---------|----------|---------|");
  for (const entry of state.errorLog) {
    parts.push(serializeErrorLogRow(entry));
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Serialize a ParsedStateFile to markdown, specifying the frontmatter values
 * for `writer` and `last_written_at` explicitly (instead of auto-setting them).
 */
export function serializeStateFileRaw(
  state: ParsedStateFile,
  frontmatterOverrides?: Record<string, unknown>,
): string {
  const parts: string[] = [];

  const fm = { ...state.frontmatter, ...frontmatterOverrides };

  parts.push("---");
  parts.push(
    yaml.dump(fm, { schema: yaml.JSON_SCHEMA, lineWidth: -1 }).trimEnd(),
  );
  parts.push("---");
  parts.push("");

  if (state.title) {
    parts.push(`# Execution State: ${state.title}`);
    parts.push("");
  }

  parts.push("## Progress");
  for (let i = 0; i < state.phases.length; i++) {
    parts.push(serializePhase(i + 1, state.phases[i]));
  }
  parts.push("");

  if (state.keyDecisions.length > 0) {
    parts.push("## Key Decisions");
    for (const decision of state.keyDecisions) {
      parts.push(`- ${decision}`);
    }
    parts.push("");
  }

  parts.push("## Error Log");
  parts.push("| Error | Attempt | Approach | Outcome |");
  parts.push("|-------|---------|----------|---------|");
  for (const entry of state.errorLog) {
    parts.push(serializeErrorLogRow(entry));
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Write state file atomically: write to .tmp -> fsync -> rename.
 *
 * The .tmp file includes a `.__flywheel__` sentinel for safe glob matching
 * during stale tmp recovery.
 *
 * Format: `${filePath}.__flywheel__.${pid}.${timestamp}.${randomHex}.tmp`
 */
export function writeStateFileAtomic(
  filePath: string,
  state: ParsedStateFile,
): void {
  const content = serializeStateFile(state);
  writeFileAtomic(filePath, content);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serializePhase(index: number, phase: ParsedPhase): string {
  const checkbox =
    phase.status === "completed"
      ? "x"
      : phase.status === "in_progress"
        ? "~"
        : " ";

  let line = `- [${checkbox}] Phase ${index}: ${phase.name}`;

  const annotationParts: string[] = [];
  for (const [key, value] of Object.entries(phase.annotations)) {
    annotationParts.push(`${key}: ${value}`);
  }
  if (annotationParts.length > 0) {
    line += ` (${annotationParts.join(", ")})`;
  }

  return line;
}

function serializeErrorLogRow(entry: ErrorLogEntry): string {
  return `| ${escapeCell(entry.error)} | ${escapeCell(entry.attempt)} | ${escapeCell(entry.approach)} | ${escapeCell(entry.outcome)} |`;
}

/**
 * Escape cell content: `|` -> `\|`, `\n` -> `<br>`
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
