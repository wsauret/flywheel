import * as yaml from "js-yaml";
import { parseFrontmatter as parseRawFrontmatter } from "../utils/frontmatter";

/**
 * Parsed representation of a `.state.md` file.
 *
 * This is the intermediate format between raw markdown (on disk) and the
 * Zod-validated StateFile schema. The reader produces this; consumers can
 * migrate/validate with Zod as needed.
 */
export interface ParsedStateFile {
  /** Raw YAML frontmatter key-value pairs */
  frontmatter: Record<string, unknown>;
  /** Document title extracted from `# Execution State: ...` */
  title: string;
  /** Parsed phase checkboxes from ## Progress */
  phases: ParsedPhase[];
  /** Key decisions section entries */
  keyDecisions: string[];
  /** Error log table rows */
  errorLog: ErrorLogEntry[];
}

export interface ParsedPhase {
  /** Phase name (e.g. "Schema definitions and validation") */
  name: string;
  /**
   * Checkbox status:
   * - "completed" = [x]
   * - "pending" = [ ]
   * - "in_progress" = [~]
   */
  status: "completed" | "pending" | "in_progress";
  /** Trailing annotations like (parallel-group: 1, commit: abc123) */
  annotations: Record<string, string>;
}

export interface ErrorLogEntry {
  error: string;
  attempt: string;
  approach: string;
  outcome: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TITLE_RE = /^#\s+Execution State:\s*(.+)$/m;
const PHASE_RE =
  /^- \[([ x~])\]\s+Phase\s+\d+:\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/;
const ANNOTATION_RE = /(\w[\w-]*):\s*([^,)]+)/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `.state.md` string into a structured representation.
 * Uses `js-yaml` with `JSON_SCHEMA` to prevent boolean/date coercion.
 */
export function parseStateFile(content: string): ParsedStateFile {
  const frontmatter = parseFrontmatter(content);
  const title = parseTitle(content);
  const phases = parsePhases(content);
  const keyDecisions = parseKeyDecisions(content);
  const errorLog = parseErrorLog(content);

  return { frontmatter, title, phases, keyDecisions, errorLog };
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, unknown> {
  const parsed = parseRawFrontmatter(content, { schema: yaml.JSON_SCHEMA });
  return parsed?.frontmatter ?? {};
}

function parseTitle(content: string): string {
  const match = content.match(TITLE_RE);
  return match ? match[1].trim() : "";
}

function parsePhases(content: string): ParsedPhase[] {
  const section = extractSection(content, "Progress");
  if (!section) return [];

  const phases: ParsedPhase[] = [];
  for (const line of section.split("\n")) {
    const match = line.match(PHASE_RE);
    if (!match) continue;

    const [, checkbox, name, annotationStr] = match;
    const status =
      checkbox === "x"
        ? "completed"
        : checkbox === "~"
          ? "in_progress"
          : "pending";

    const annotations: Record<string, string> = {};
    if (annotationStr) {
      let m: RegExpExecArray | null;
      // Reset lastIndex for global regex
      ANNOTATION_RE.lastIndex = 0;
      while ((m = ANNOTATION_RE.exec(annotationStr)) !== null) {
        annotations[m[1]] = m[2].trim();
      }
    }

    phases.push({ name: name.trim(), status, annotations });
  }

  return phases;
}

function parseKeyDecisions(content: string): string[] {
  const section = extractSection(content, "Key Decisions");
  if (!section) return [];

  const decisions: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      decisions.push(trimmed.slice(2));
    }
  }
  return decisions;
}

function parseErrorLog(content: string): ErrorLogEntry[] {
  const section = extractSection(content, "Error Log");
  if (!section) return [];

  const lines = section.split("\n").filter((l) => l.trim().length > 0);

  // Need at least header + separator + 1 data row
  if (lines.length < 3) return [];

  // Skip header (line 0) and separator (line 1)
  const entries: ErrorLogEntry[] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = parseTableRow(lines[i]);
    if (row.length >= 4) {
      entries.push({
        error: unescapeCell(row[0]),
        attempt: unescapeCell(row[1]),
        approach: unescapeCell(row[2]),
        outcome: unescapeCell(row[3]),
      });
    }
  }
  return entries;
}

/**
 * Extract the content between a `## <heading>` and the next `##` (or EOF).
 */
function extractSection(
  content: string,
  heading: string,
): string | null {
  const re = new RegExp(
    `^## ${escapeRegExp(heading)}\\s*$`,
    "m",
  );
  const match = re.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  // Find next ## heading or EOF
  const nextHeading = content.indexOf("\n## ", start);
  const end = nextHeading === -1 ? content.length : nextHeading;
  return content.slice(start, end);
}

/**
 * Parse a markdown table row into cell values.
 * Handles escaped pipes (\|) inside cells.
 */
function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];

  // Remove leading and trailing pipes
  const inner = trimmed.slice(1, -1);

  // Split on unescaped pipes: find | that are NOT preceded by \
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "|" && (i === 0 || inner[i - 1] !== "\\")) {
      cells.push(current.trim());
      current = "";
    } else {
      current += inner[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Unescape cell content: `\|` -> `|`, `<br>` -> `\n`
 */
function unescapeCell(cell: string): string {
  return cell.replace(/\\\|/g, "|").replace(/<br>/gi, "\n");
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
