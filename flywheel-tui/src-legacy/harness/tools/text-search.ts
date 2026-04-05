/**
 * Text/regex search tool using native ripgrep bindings.
 *
 * Wraps the grep() function from src/harness/ripgrep.ts to provide
 * file content search with pattern matching, glob filtering, and
 * two output modes (file_paths and content).
 */

import * as path from "node:path";
import { z } from "zod";
import { grep } from "./ripgrep.js";
import type { ConcurrencyMode, HarnessTool, ToolContext, ToolResult } from "./types.js";

const MAX_OUTPUT_BYTES = 50_000;
const MAX_MATCHES = 500;
const DEFAULT_HEAD_LIMIT = 200;

const textSearchInputSchema = z.object({
	pattern: z.string().describe("Regex or literal pattern to search for"),
	path: z
		.string()
		.optional()
		.describe("File or directory to search (default: cwd)"),
	glob_pattern: z
		.string()
		.optional()
		.describe('Glob pattern to filter files (e.g. "*.ts")'),
	type: z
		.string()
		.optional()
		.describe('Ripgrep file type filter (e.g. "js", "py", "rust")'),
	case_insensitive: z
		.boolean()
		.optional()
		.describe("Case-insensitive search (default: false)"),
	context: z
		.number()
		.optional()
		.describe("Lines of context around each match"),
	output_mode: z
		.enum(["file_paths", "content"])
		.optional()
		.default("file_paths")
		.describe('Output mode: "file_paths" (default) or "content"'),
	head_limit: z
		.number()
		.optional()
		.describe("Maximum number of matches to return"),
});

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_BYTES) return output;
	const truncated = output.slice(0, MAX_OUTPUT_BYTES);
	const lastNewline = truncated.lastIndexOf("\n");
	const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
	return `${clean}\n\n... output truncated (exceeded ${MAX_OUTPUT_BYTES} bytes)`;
}

async function execute(input: unknown, context: ToolContext): Promise<ToolResult> {
	const parsed = textSearchInputSchema.safeParse(input);
	if (!parsed.success) {
		return { content: `Invalid input: ${parsed.error.message}`, isError: true };
	}

	const {
		pattern,
		path: searchPath,
		glob_pattern,
		type: fileType,
		case_insensitive,
		context: contextLines,
		output_mode,
		head_limit,
	} = parsed.data;

	if (!pattern.trim()) {
		return { content: "Pattern must not be empty", isError: true };
	}

	const resolvedPath = searchPath
		? searchPath.startsWith("/")
			? searchPath
			: path.resolve(context.cwd, searchPath)
		: context.cwd;

	const effectiveLimit = head_limit ?? DEFAULT_HEAD_LIMIT;
	const mode = output_mode === "content" ? "content" : "filesWithMatches";

	try {
		const result = grep({
			pattern,
			path: resolvedPath,
			glob: glob_pattern,
			type: fileType,
			ignoreCase: case_insensitive ?? false,
			maxCount: Math.min(effectiveLimit, MAX_MATCHES),
			context: contextLines,
			mode,
		});

		if (result.matches.length === 0) {
			return { content: "No matches found" };
		}

		if (output_mode === "content") {
			return formatContentOutput(result.matches, result, resolvedPath, context.cwd, effectiveLimit);
		}
		return formatFilePathsOutput(result.matches, result, resolvedPath, context.cwd, effectiveLimit);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("regex parse error")) {
			return { content: `Invalid regex pattern: ${err.message}`, isError: true };
		}
		if (err instanceof Error) {
			return { content: `Search error: ${err.message}`, isError: true };
		}
		return { content: `Search error: ${String(err)}`, isError: true };
	}
}

interface GrepMatchLike {
	path: string;
	lineNumber: number;
	line: string;
	contextBefore?: Array<{ lineNumber: number; line: string }>;
	contextAfter?: Array<{ lineNumber: number; line: string }>;
}

interface GrepResultLike {
	totalMatches: number;
	filesWithMatches: number;
	limitReached?: boolean;
}

function formatFilePathsOutput(
	matches: GrepMatchLike[],
	result: GrepResultLike,
	_resolvedPath: string,
	cwd: string,
	limit: number,
): ToolResult {
	const uniquePaths = new Set<string>();
	for (const match of matches) {
		const rel = path.relative(cwd, match.path);
		uniquePaths.add(rel || match.path);
	}

	const paths = [...uniquePaths];
	const lines: string[] = [];
	for (const p of paths) {
		lines.push(p);
	}

	const summary = `Found matches in ${paths.length} file(s)`;
	const truncationNote =
		result.limitReached || matches.length >= limit ? "\n\n... results truncated" : "";

	const output = `${summary}\n\n${lines.join("\n")}${truncationNote}`;
	return { content: truncateOutput(output) };
}

function formatContentOutput(
	matches: GrepMatchLike[],
	result: GrepResultLike,
	_resolvedPath: string,
	cwd: string,
	limit: number,
): ToolResult {
	const lines: string[] = [];
	let currentFile = "";

	for (const match of matches) {
		const rel = path.relative(cwd, match.path);
		const displayPath = rel || match.path;

		if (displayPath !== currentFile) {
			if (currentFile) lines.push("");
			lines.push(`# ${displayPath}`);
			currentFile = displayPath;
		}

		if (match.contextBefore) {
			for (const ctx of match.contextBefore) {
				lines.push(`  ${ctx.lineNumber}: ${ctx.line}`);
			}
		}

		lines.push(`>> ${match.lineNumber}: ${match.line}`);

		if (match.contextAfter) {
			for (const ctx of match.contextAfter) {
				lines.push(`  ${ctx.lineNumber}: ${ctx.line}`);
			}
		}
	}

	const summary = `${result.totalMatches} match(es) in ${result.filesWithMatches} file(s)`;
	const truncationNote =
		result.limitReached || matches.length >= limit ? "\n\n... results truncated" : "";

	const output = `${summary}\n\n${lines.join("\n")}${truncationNote}`;
	return { content: truncateOutput(output) };
}

export const textSearchTool: HarnessTool = {
	name: "text_search",
	description:
		'Search file contents using regex or literal patterns via native ripgrep. Supports glob filtering, file type filtering, case-insensitive search, and context lines. Two output modes: "file_paths" lists matching files, "content" shows matching lines with context.',
	inputSchema: textSearchInputSchema,
	concurrency: "shared" as ConcurrencyMode,
	execute,
};
