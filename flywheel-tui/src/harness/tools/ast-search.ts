/**
 * Structural code search tool using @ast-grep/napi.
 *
 * Parses source files and searches for AST pattern matches,
 * supporting language-specific structural queries with metavariables.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { z } from "zod";
import type { ConcurrencyMode, HarnessTool, ToolContext, ToolResult } from "./types.js";

const MAX_MATCHES = 200;
const MAX_OUTPUT_BYTES = 50_000;

const astSearchInputSchema = z.object({
	pattern: z.string().describe("AST pattern to match (ast-grep pattern syntax)"),
	language: z
		.string()
		.optional()
		.describe('Language override (e.g. "typescript", "javascript", "python")'),
	path: z
		.string()
		.optional()
		.describe("File or directory to search (default: cwd)"),
});

/** Map user-friendly language names to ast-grep Lang enum values. */
const LANG_MAP: Record<string, Lang> = {
	typescript: Lang.TypeScript,
	ts: Lang.TypeScript,
	tsx: Lang.Tsx,
	javascript: Lang.JavaScript,
	js: Lang.JavaScript,
	jsx: Lang.Tsx,
	html: Lang.Html,
	css: Lang.Css,
};

/** File extensions associated with each language. */
const LANG_EXTENSIONS: Record<string, string[]> = {
	[Lang.TypeScript]: [".ts", ".mts", ".cts"],
	[Lang.Tsx]: [".tsx", ".jsx"],
	[Lang.JavaScript]: [".js", ".mjs", ".cjs"],
	[Lang.Html]: [".html", ".htm"],
	[Lang.Css]: [".css"],
};

function resolveLang(input: string | undefined): Lang | null {
	if (!input) return null;
	const normalized = input.toLowerCase().trim();
	return LANG_MAP[normalized] ?? null;
}

function inferLangFromExtension(filePath: string): Lang | null {
	const ext = path.extname(filePath).toLowerCase();
	for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
		if (exts.includes(ext)) return lang as Lang;
	}
	return null;
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_BYTES) return output;
	const truncated = output.slice(0, MAX_OUTPUT_BYTES);
	const lastNewline = truncated.lastIndexOf("\n");
	const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
	return `${clean}\n\n... output truncated (exceeded ${MAX_OUTPUT_BYTES} bytes)`;
}

interface MatchResult {
	file: string;
	startLine: number;
	endLine: number;
	text: string;
	metaVariables: Record<string, string>;
}

async function searchFile(
	filePath: string,
	patternStr: string,
	lang: Lang,
): Promise<MatchResult[]> {
	const content = await fs.readFile(filePath, "utf-8");
	const root = parse(lang, content);
	const rootNode = root.root();
	const matches = rootNode.findAll(patternStr);

	return matches.map(node => {
		const range = node.range();
		// ast-grep uses 0-based lines; convert to 1-based
		const startLine = range.start.line + 1;
		const endLine = range.end.line + 1;
		const text = node.text();

		// Extract metavariables by checking common single-character names
		const metaVariables: Record<string, string> = {};
		for (const name of ["A", "B", "C", "D", "E", "F", "X", "Y", "Z", "NAME", "ARGS", "BODY", "VALUE", "TYPE", "RET", "FN", "EXPR", "PATTERN"]) {
			const mv = node.getMatch(`$${name}`);
			if (mv) {
				metaVariables[`$${name}`] = mv.text();
			}
		}

		return { file: filePath, startLine, endLine, text, metaVariables };
	});
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

async function walkFiles(dir: string, lang: Lang): Promise<string[]> {
	const extensions = LANG_EXTENSIONS[lang];
	if (!extensions) return [];

	const result: string[] = [];

	async function walk(currentDir: string): Promise<void> {
		let names: string[];
		try {
			names = await fs.readdir(currentDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (SKIP_DIRS.has(name)) continue;
			const fullPath = path.join(currentDir, name);
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(fullPath);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				await walk(fullPath);
			} else if (stat.isFile()) {
				const ext = path.extname(name).toLowerCase();
				if (extensions.includes(ext)) {
					result.push(fullPath);
				}
			}
		}
	}

	await walk(dir);
	return result;
}

async function execute(input: unknown, context: ToolContext): Promise<ToolResult> {
	const parsed = astSearchInputSchema.safeParse(input);
	if (!parsed.success) {
		return { content: `Invalid input: ${parsed.error.message}`, isError: true };
	}

	const { pattern: patternStr, language, path: searchPath } = parsed.data;

	if (!patternStr.trim()) {
		return { content: "Pattern must not be empty", isError: true };
	}

	const resolvedPath = searchPath
		? searchPath.startsWith("/")
			? searchPath
			: path.resolve(context.cwd, searchPath)
		: context.cwd;

	// Determine target language
	let lang = resolveLang(language);

	// Check if path is a file or directory
	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(resolvedPath);
	} catch {
		return { content: `Path not found: ${searchPath ?? "."}`, isError: true };
	}

	const allMatches: MatchResult[] = [];

	try {
		if (stat.isFile()) {
			if (!lang) {
				lang = inferLangFromExtension(resolvedPath);
			}
			if (!lang) {
				return {
					content: `Cannot determine language for file: ${resolvedPath}. Specify the "language" parameter.`,
					isError: true,
				};
			}

			const matches = await searchFile(resolvedPath, patternStr, lang);
			allMatches.push(...matches);
		} else if (stat.isDirectory()) {
			// Default to TypeScript for directory searches
			if (!lang) {
				lang = Lang.TypeScript;
			}

			const files = await walkFiles(resolvedPath, lang);
			for (const file of files) {
				if (allMatches.length >= MAX_MATCHES) break;
				try {
					const matches = await searchFile(file, patternStr, lang);
					allMatches.push(...matches);
				} catch {
					// Skip files that fail to parse
					continue;
				}
			}
		} else {
			return { content: `Path is not a file or directory: ${searchPath ?? "."}`, isError: true };
		}
	} catch (err) {
		if (err instanceof Error) {
			return { content: `AST search error: ${err.message}`, isError: true };
		}
		return { content: `AST search error: ${String(err)}`, isError: true };
	}

	if (allMatches.length === 0) {
		return { content: "No matches found" };
	}

	// Format output
	const lines: string[] = [];
	const fileGroups = new Map<string, MatchResult[]>();
	for (const match of allMatches.slice(0, MAX_MATCHES)) {
		const rel = path.relative(context.cwd, match.file);
		const displayPath = rel || match.file;
		if (!fileGroups.has(displayPath)) {
			fileGroups.set(displayPath, []);
		}
		fileGroups.get(displayPath)!.push(match);
	}

	const matchCount = Math.min(allMatches.length, MAX_MATCHES);
	const fileCount = fileGroups.size;
	lines.push(`${matchCount} match(es) in ${fileCount} file(s)`);
	lines.push("");

	for (const [filePath, matches] of fileGroups) {
		lines.push(`# ${filePath}`);
		for (const match of matches) {
			const matchLines = match.text.split("\n");
			for (let i = 0; i < matchLines.length; i++) {
				const lineNum = match.startLine + i;
				lines.push(`  ${lineNum}: ${matchLines[i]}`);
			}
			// Show metavariables if any
			const metaEntries = Object.entries(match.metaVariables);
			if (metaEntries.length > 0) {
				const serialized = metaEntries
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				lines.push(`  meta: ${serialized}`);
			}
		}
		lines.push("");
	}

	const truncationNote = allMatches.length > MAX_MATCHES ? "... results truncated\n" : "";
	const output = `${lines.join("\n")}${truncationNote}`;

	return { content: truncateOutput(output) };
}

export const astSearchTool: HarnessTool = {
	name: "ast_search",
	description:
		"Search code using AST patterns via ast-grep. Finds structural matches in source files, supporting metavariable capture for extracting specific code elements. Useful for finding function declarations, class patterns, import statements, and other structural code patterns.",
	inputSchema: astSearchInputSchema,
	concurrency: "shared" as ConcurrencyMode,
	execute,
};
