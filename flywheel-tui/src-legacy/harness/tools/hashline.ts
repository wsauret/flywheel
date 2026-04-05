/**
 * Hashline edit mode — a line-addressable edit format using text hashes.
 *
 * Each line in a file is identified by its 1-indexed line number and a short
 * hash derived from the normalized line text (xxHash32, truncated to 2 chars).
 * The combined `LINE#ID` reference acts as both an address and a staleness check:
 * if the file has changed since the caller last read it, hash mismatches are caught
 * before any mutation occurs.
 *
 * Displayed format: `LINENUM#HASH:TEXT`
 * Reference format: `"LINENUM#HASH"` (e.g. `"5#KX"`)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Hash Alphabet
// ═══════════════════════════════════════════════════════════════════════════

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]!}${NIBBLE_STR[l]!}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

// ═══════════════════════════════════════════════════════════════════════════
// Hash Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a short 2-character hash of a single line.
 *
 * Uses xxHash32 on a trailing-whitespace-trimmed, CR-stripped line, truncated to 2 chars
 * from the NIBBLE_STR alphabet. For lines containing no alphanumeric characters
 * (only punctuation/symbols/whitespace), the line number is mixed in as a seed to
 * reduce hash collisions.
 *
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();

	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return DICT[Bun.hash.xxHash32(line, seed) & 0xff]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a line tag given the line number and line text.
 * Returns a string like `5#KX`.
 */
export function formatLineTag(lineNumber: number, lineText: string): string {
	return `${lineNumber}#${computeLineHash(lineNumber, lineText)}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINENUM#HASH:TEXT` where LINENUM is 1-indexed.
 */
export function formatHashLines(content: string): string {
	const lines = content.split("\n");
	return lines
		.map((line, i) => {
			const num = i + 1;
			return `${formatLineTag(num, line)}:${line}`;
		})
		.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Parsing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a line reference string like `"5#KX"` into structured form.
 *
 * Handles both `LINE#HASH` and bare `LINE` formats.
 * Returns null if the format is invalid.
 */
export function parseTag(tag: string): { line: number; hash: string } | null {
	const match = tag.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
	if (match) {
		const line = Number.parseInt(match[1]!, 10);
		if (line < 1) return null;
		return { line, hash: match[2]! };
	}
	// Bare line number format (no hash)
	const bareMatch = tag.match(/^\s*(\d+)\s*$/);
	if (bareMatch) {
		const line = Number.parseInt(bareMatch[1]!, 10);
		if (line < 1) return null;
		return { line, hash: "" };
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash Mismatch Types & Error
// ═══════════════════════════════════════════════════════════════════════════

export interface HashMismatch {
	/** 1-indexed line number */
	line: number;
	/** Hash the caller provided */
	expected: string;
	/** Hash computed from the current file content */
	actual: string;
}

/** Number of context lines shown above/below each mismatched line */
const MISMATCH_CONTEXT = 2;

/**
 * Error thrown when one or more hashline references have stale hashes.
 *
 * Displays grep-style output with `>>>` markers on mismatched lines,
 * showing the correct `LINE#ID` so the caller can fix all refs at once.
 */
export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;

	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
		const remaps = new Map<string, string>();
		for (const m of mismatches) {
			const actual = computeLineHash(m.line, fileLines[m.line - 1]!);
			remaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
		}
		this.remaps = remaps;
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Map<number, HashMismatch>();
		for (const m of mismatches) {
			mismatchSet.set(m.line, m);
		}

		const displayLines = new Set<number>();
		for (const m of mismatches) {
			const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
			const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
			for (let i = lo; i <= hi; i++) {
				displayLines.add(i);
			}
		}

		const sorted = [...displayLines].sort((a, b) => a - b);
		const lines: string[] = [];

		lines.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`,
		);
		lines.push("");

		let prevLine = -1;
		for (const lineNum of sorted) {
			if (prevLine !== -1 && lineNum > prevLine + 1) {
				lines.push("    ...");
			}
			prevLine = lineNum;

			const text = fileLines[lineNum - 1]!;
			const hash = computeLineHash(lineNum, text);
			const prefix = `${lineNum}#${hash}`;

			if (mismatchSet.has(lineNum)) {
				lines.push(`>>> ${prefix}:${text}`);
			} else {
				lines.push(`    ${prefix}:${text}`);
			}
		}
		return lines.join("\n");
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate that a line reference points to an existing line with a matching hash.
 *
 * @param lines - Array of file lines (0-indexed)
 * @param lineNumber - 1-indexed line number
 * @param hash - Expected hash string
 * @throws HashlineMismatchError if the hash doesn't match
 * @throws Error if the line is out of range
 */
export function validateLineRef(lines: string[], lineNumber: number, hash: string): void {
	if (lineNumber < 1 || lineNumber > lines.length) {
		throw new Error(`Line ${lineNumber} does not exist (file has ${lines.length} lines)`);
	}
	const actualHash = computeLineHash(lineNumber, lines[lineNumber - 1]!);
	if (actualHash !== hash) {
		throw new HashlineMismatchError(
			[{ line: lineNumber, expected: hash, actual: actualHash }],
			lines,
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Zod Schemas
// ═══════════════════════════════════════════════════════════════════════════

export const hashlineEditSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("insert_before"),
		target: z.string().describe("Target line reference (e.g. '5#KX')"),
		lines: z.array(z.string()).describe("Lines to insert before the target"),
	}),
	z.object({
		op: z.literal("insert_after"),
		target: z.string().describe("Target line reference (e.g. '5#KX')"),
		lines: z.array(z.string()).describe("Lines to insert after the target"),
	}),
	z.object({
		op: z.literal("replace"),
		start: z.string().describe("Start line reference (inclusive)"),
		end: z.string().describe("End line reference (inclusive)"),
		lines: z.array(z.string()).describe("Replacement lines"),
	}),
	z.object({
		op: z.literal("delete"),
		start: z.string().describe("Start line reference (inclusive)"),
		end: z.string().describe("End line reference (inclusive)"),
	}),
	z.object({
		op: z.literal("replace_all"),
		lines: z.array(z.string()).describe("New file content lines"),
	}),
	z.object({
		op: z.literal("create"),
		lines: z.array(z.string()).describe("File content lines"),
	}),
]);

export type HashlineEdit = z.infer<typeof hashlineEditSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Strip Hashline Prefixes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pattern matching hashline display format prefixes: `LINE#ID:CONTENT`.
 */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\+?\s*(?:\d+\s*#\s*|#\s*)|\+)\s*[ZPMQVRWSNKTXJBYH]{2}:/;

/**
 * Strip hashline display prefixes from content that models accidentally copy.
 *
 * Removes `LINE#HASH: ` prefixes when every non-empty line has one.
 * Returns the cleaned string.
 */
export function stripHashlinePrefixes(content: string): string {
	const lines = content.split("\n");
	let hashPrefixCount = 0;
	let nonEmpty = 0;
	for (const l of lines) {
		if (l.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
	}
	if (nonEmpty === 0 || hashPrefixCount !== nonEmpty) return content;
	return lines.map(l => l.replace(HASHLINE_PREFIX_RE, "")).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Edit Representation
// ═══════════════════════════════════════════════════════════════════════════

type Anchor = { line: number; hash: string };

type InternalEdit =
	| { op: "insert_before"; pos: Anchor; lines: string[] }
	| { op: "insert_after"; pos: Anchor; lines: string[] }
	| { op: "replace"; pos: Anchor; end: Anchor; lines: string[] }
	| { op: "delete"; pos: Anchor; end: Anchor }
	| { op: "replace_all"; lines: string[] }
	| { op: "create"; lines: string[] };

/**
 * Convert a schema-validated edit into an internal edit with parsed anchors.
 */
function resolveEdit(edit: HashlineEdit): InternalEdit {
	switch (edit.op) {
		case "insert_before": {
			const anchor = parseTag(edit.target);
			if (!anchor || !anchor.hash) throw new Error(`Invalid target reference: "${edit.target}"`);
			return { op: "insert_before", pos: anchor, lines: edit.lines };
		}
		case "insert_after": {
			const anchor = parseTag(edit.target);
			if (!anchor || !anchor.hash) throw new Error(`Invalid target reference: "${edit.target}"`);
			return { op: "insert_after", pos: anchor, lines: edit.lines };
		}
		case "replace": {
			const start = parseTag(edit.start);
			const end = parseTag(edit.end);
			if (!start || !start.hash) throw new Error(`Invalid start reference: "${edit.start}"`);
			if (!end || !end.hash) throw new Error(`Invalid end reference: "${edit.end}"`);
			if (start.line > end.line) {
				throw new Error(`Range start line ${start.line} must be <= end line ${end.line}`);
			}
			return { op: "replace", pos: start, end, lines: edit.lines };
		}
		case "delete": {
			const start = parseTag(edit.start);
			const end = parseTag(edit.end);
			if (!start || !start.hash) throw new Error(`Invalid start reference: "${edit.start}"`);
			if (!end || !end.hash) throw new Error(`Invalid end reference: "${edit.end}"`);
			if (start.line > end.line) {
				throw new Error(`Range start line ${start.line} must be <= end line ${end.line}`);
			}
			return { op: "delete", pos: start, end };
		}
		case "replace_all":
			return { op: "replace_all", lines: edit.lines };
		case "create":
			return { op: "create", lines: edit.lines };
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Edit Application
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply an array of hashline edits to a file.
 *
 * **Fully transactional:** All edits are validated before any mutation.
 * If any hash mismatch is found, no changes are written to disk.
 *
 * Edits are sorted bottom-up (highest effective line first) so earlier
 * splices don't invalidate later line numbers.
 *
 * @param filePath - Absolute path to the target file
 * @param edits - Array of validated hashline edit operations
 * @throws HashlineMismatchError if any edit has stale hashes
 */
export async function applyHashlineEdits(filePath: string, edits: HashlineEdit[]): Promise<void> {
	if (edits.length === 0) return;

	// Check for create op — file should not exist yet
	const hasCreate = edits.some(e => e.op === "create");
	if (hasCreate) {
		if (edits.length !== 1) {
			throw new Error("A 'create' edit must be the only edit in the batch");
		}
		const createEdit = edits[0]!;
		if (createEdit.op !== "create") throw new Error("Expected create edit");
		const dir = path.dirname(filePath);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(filePath, createEdit.lines.join("\n"));
		return;
	}

	// Check for replace_all op
	const hasReplaceAll = edits.some(e => e.op === "replace_all");
	if (hasReplaceAll) {
		if (edits.length !== 1) {
			throw new Error("A 'replace_all' edit must be the only edit in the batch");
		}
		const replaceAllEdit = edits[0]!;
		if (replaceAllEdit.op !== "replace_all") throw new Error("Expected replace_all edit");
		await fs.writeFile(filePath, replaceAllEdit.lines.join("\n"));
		return;
	}

	// Read existing file
	const content = await fs.readFile(filePath, "utf-8");
	const fileLines = content.split("\n");

	// Resolve all edits to internal representation
	const internalEdits = edits.map(e => resolveEdit(e));

	// Phase 1: Validate ALL edits before mutating anything
	const mismatches: HashMismatch[] = [];

	for (const edit of internalEdits) {
		switch (edit.op) {
			case "insert_before":
			case "insert_after": {
				collectMismatch(edit.pos, fileLines, mismatches);
				break;
			}
			case "replace":
			case "delete": {
				collectMismatch(edit.pos, fileLines, mismatches);
				collectMismatch(edit.end, fileLines, mismatches);
				break;
			}
			case "replace_all":
			case "create":
				break;
		}
	}

	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}

	// Phase 2: Sort edits bottom-up for correct application
	const annotated = internalEdits.map((edit, idx) => {
		let sortLine: number;
		switch (edit.op) {
			case "insert_before":
				sortLine = edit.pos.line;
				break;
			case "insert_after":
				sortLine = edit.pos.line;
				break;
			case "replace":
				sortLine = edit.end.line;
				break;
			case "delete":
				sortLine = edit.end.line;
				break;
			default:
				sortLine = 0;
				break;
		}
		return { edit, idx, sortLine };
	});

	annotated.sort((a, b) => b.sortLine - a.sortLine || a.idx - b.idx);

	// Phase 3: Apply edits bottom-up
	let changed = false;
	for (const { edit } of annotated) {
		switch (edit.op) {
			case "insert_before": {
				fileLines.splice(edit.pos.line - 1, 0, ...edit.lines);
				if (edit.lines.length > 0) changed = true;
				break;
			}
			case "insert_after": {
				fileLines.splice(edit.pos.line, 0, ...edit.lines);
				if (edit.lines.length > 0) changed = true;
				break;
			}
			case "replace": {
				const count = edit.end.line - edit.pos.line + 1;
				const oldLines = fileLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count);
				if (oldLines.length !== edit.lines.length || oldLines.some((l, i) => l !== edit.lines[i])) {
					fileLines.splice(edit.pos.line - 1, count, ...edit.lines);
					changed = true;
				}
				break;
			}
			case "delete": {
				const count = edit.end.line - edit.pos.line + 1;
				fileLines.splice(edit.pos.line - 1, count);
				changed = true;
				break;
			}
		}
	}

	// Noop detection: if nothing changed, skip the write
	if (!changed) return;

	// Phase 4: Write the result to disk
	await fs.writeFile(filePath, fileLines.join("\n"));
}

/**
 * Collect hash mismatches for validation. Adds to the mismatches array
 * if the anchor's hash doesn't match the actual file content.
 */
function collectMismatch(anchor: Anchor, fileLines: string[], mismatches: HashMismatch[]): void {
	if (anchor.line < 1 || anchor.line > fileLines.length) {
		throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]!);
	if (actualHash !== anchor.hash) {
		mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
	}
}
