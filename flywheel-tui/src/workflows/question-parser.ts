/**
 * Parses open questions from plan review output.
 *
 * Supports three formats:
 * 1. Numbered list under `## Open Questions` section
 * 2. Markdown table under `## Open Questions` section
 * 3. Bold `**OPEN QUESTION:**` blocks (contradiction format)
 *
 * Deduplicates similar questions (case-insensitive, stripped of backticks).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface OpenQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  source?: string;
  default?: string;
}

export interface ResolvedQuestion {
  question: string;
  answers: string[];
  source: "user" | "auto";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse open questions from review output. Handles numbered lists, tables,
 * and OPEN QUESTION blocks. Deduplicates similar questions.
 */
export function parseOpenQuestions(reviewOutput: string): OpenQuestion[] {
  if (!reviewOutput.trim()) return [];

  const questions: OpenQuestion[] = [];

  // Parse all three formats
  questions.push(...parseNumberedList(reviewOutput));
  questions.push(...parseTable(reviewOutput));
  questions.push(...parseOpenQuestionBlocks(reviewOutput));

  // Deduplicate
  return deduplicateQuestions(questions);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Section headings that contain open questions.
 * "Open Questions" is the canonical heading from the plan review prompt template.
 */
const QUESTION_SECTION_HEADINGS = [
  "Open Questions",
];

/**
 * Parse numbered questions from a questions section.
 * Tries multiple heading variants to handle agent output deviations.
 * Handles multi-line questions (continuation lines starting with whitespace).
 */
function parseNumberedList(output: string): OpenQuestion[] {
  for (const heading of QUESTION_SECTION_HEADINGS) {
    const section = extractSection(output, heading);
    if (!section) continue;

    // Skip if this section contains a table (handled by parseTable)
    if (section.includes("| # |") || section.includes("|---|")) continue;

    const questions = parseNumberedListFromSection(section);
    if (questions.length > 0) return questions;
  }

  return [];
}

/**
 * Parse numbered questions from a section's content.
 */
function parseNumberedListFromSection(section: string): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  const lines = section.split("\n");
  let currentQuestion = "";

  for (const line of lines) {
    const numbered = line.match(/^\s*\d+\.\s+(.+)/);
    if (numbered) {
      // Save previous question if any
      if (currentQuestion) {
        questions.push(makeQuestion(currentQuestion.trim()));
      }
      currentQuestion = numbered[1];
    } else if (currentQuestion && line.match(/^\s{2,}/) && line.trim()) {
      // Continuation line (indented)
      currentQuestion += " " + line.trim();
    } else if (currentQuestion && !line.trim()) {
      // Blank line ends the question
      questions.push(makeQuestion(currentQuestion.trim()));
      currentQuestion = "";
    }
  }

  // Don't forget the last question
  if (currentQuestion) {
    questions.push(makeQuestion(currentQuestion.trim()));
  }

  return questions;
}

/**
 * Parse questions from a markdown table in a questions section.
 * Tries multiple heading variants. Expects columns: #, Question, Options (optional), Source(s) (optional).
 */
function parseTable(output: string): OpenQuestion[] {
  let section: string | null = null;
  for (const heading of QUESTION_SECTION_HEADINGS) {
    section = extractSection(output, heading);
    if (section) break;
  }
  if (!section) return [];

  // Must contain a table
  if (!section.includes("|")) return [];

  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];

  // Find header row to identify column positions
  const headerRow = lines[0];
  const headers = parseTableRow(headerRow).map((h) => h.toLowerCase().trim());

  const questionCol = headers.findIndex(
    (h) => h === "question" || h.includes("question")
  );
  const optionsCol = headers.findIndex(
    (h) => h === "options" || h.includes("options")
  );
  const sourceCol = headers.findIndex(
    (h) => h === "source" || h.includes("source")
  );

  if (questionCol === -1) return [];

  const questions: OpenQuestion[] = [];

  // Skip header and separator rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Skip separator row (|---|---|...)
    if (line.match(/^\|[\s-|]+\|$/)) continue;

    const cells = parseTableRow(line);
    const questionText = cells[questionCol]?.trim();
    if (!questionText) continue;

    const options =
      optionsCol !== -1 ? parseTableOptions(cells[optionsCol] ?? "") : [];
    const source =
      sourceCol !== -1 ? cells[sourceCol]?.trim() : undefined;

    questions.push(
      makeQuestion(questionText, options, source)
    );
  }

  return questions;
}

/**
 * Parse `**OPEN QUESTION:**` blocks from anywhere in the output.
 * Captures only the first line after the marker (the actual question),
 * not the subsequent `- Reviewer says:` context lines.
 */
function parseOpenQuestionBlocks(output: string): OpenQuestion[] {
  const questions: OpenQuestion[] = [];
  const regex = /\*\*OPEN QUESTION:\*\*\s*(.+)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const questionText = match[1].trim();
    if (questionText) {
      questions.push(makeQuestion(questionText));
    }
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract content of a `## <heading>` section (up to the next `##` heading or end).
 */
export function extractSection(
  output: string,
  heading: string
): string | null {
  const regex = new RegExp(
    `^##\\s+${escapeRegex(heading)}\\s*$`,
    "m"
  );
  const match = regex.exec(output);
  if (!match) return null;

  const start = match.index + match[0].length;
  const nextHeading = output.indexOf("\n## ", start);
  const end = nextHeading !== -1 ? nextHeading : output.length;

  const content = output.slice(start, end).trim();
  return content || null;
}

/**
 * Parse a single markdown table row into an array of cell values.
 */
export function parseTableRow(row: string): string[] {
  return row
    .split("|")
    .slice(1, -1) // Remove leading/trailing empty strings from | ... |
    .map((cell) => cell.trim());
}

/**
 * Parse options from a table cell like "A: `true` B: `false` C: Split flags"
 */
function parseTableOptions(optionsText: string): QuestionOption[] {
  if (!optionsText.trim()) return [];

  const options: QuestionOption[] = [];
  // Match patterns like "A: <value>" or "A: `value`"
  const regex = /([A-Z]):\s*(.+?)(?=\s+[A-Z]:\s|$)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(optionsText)) !== null) {
    const label = match[2].trim().replace(/`/g, "");
    if (label) {
      options.push({ label, description: "" });
    }
  }

  return options;
}

/**
 * Create an OpenQuestion with a generated header.
 */
function makeQuestion(
  text: string,
  options: QuestionOption[] = [],
  source?: string
): OpenQuestion {
  return {
    question: text,
    header: generateHeader(text),
    options,
    source,
  };
}

/**
 * Generate a short header (≤30 chars) from question text.
 * Strips backticks, takes first meaningful words.
 */
function generateHeader(question: string): string {
  const clean = question
    .replace(/`/g, "")
    .replace(/\?$/, "")
    .trim();

  // Remove common prefixes
  const stripped = clean
    .replace(/^(Should|How should|What|Where|When|Why|Does|Do|Is|Are|Can|Will)\s+(we\s+|the\s+|it\s+)?/i, "")
    .trim();

  if (stripped.length <= 30) return stripped;

  // Truncate to 30 chars at a word boundary
  const truncated = stripped.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Normalize question text for deduplication comparison.
 * Lowercase, strip backticks, collapse whitespace.
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deduplicate questions by normalized text similarity.
 * First occurrence wins (preserves original formatting and options).
 */
function deduplicateQuestions(questions: OpenQuestion[]): OpenQuestion[] {
  const seen = new Set<string>();
  const result: OpenQuestion[] = [];

  for (const q of questions) {
    const key = normalizeForComparison(q.question);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(q);
    }
  }

  return result;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
