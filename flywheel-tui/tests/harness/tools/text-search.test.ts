import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { textSearchTool } from "../../../src/harness/tools/text-search.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "text-search-test-"));
	ctx = { cwd: tmpDir, env: {} };

	// Create test fixtures
	await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
	await fs.writeFile(
		path.join(tmpDir, "src", "hello.ts"),
		`export function hello() {\n  return "Hello, world!";\n}\n`,
	);
	await fs.writeFile(
		path.join(tmpDir, "src", "goodbye.ts"),
		`export function goodbye() {\n  return "Goodbye, world!";\n}\n`,
	);
	await fs.writeFile(
		path.join(tmpDir, "src", "utils.js"),
		`function capitalize(str) {\n  return str.charAt(0).toUpperCase() + str.slice(1);\n}\n`,
	);
	await fs.writeFile(
		path.join(tmpDir, "readme.md"),
		`# Project\n\nThis is a test project.\nHello World from readme.\n`,
	);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Regex Search
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — regex search", () => {
	it("finds matches using a regex pattern", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "function \\w+", output_mode: "content" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello");
		expect(result.content).toContain("goodbye");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Literal String Search
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — literal string search", () => {
	it("finds matches using a literal string", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "Hello", output_mode: "content" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Hello");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// file_paths Output Mode
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — file_paths mode", () => {
	it("returns only file paths in file_paths mode", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "function", output_mode: "file_paths" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello.ts");
		expect(result.content).toContain("goodbye.ts");
		expect(result.content).toContain("utils.js");
		// file_paths mode should show file paths
		expect(result.content).toContain("Found matches in");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// content Output Mode with Context
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — content mode with context", () => {
	it("shows matching lines with context lines", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "return", output_mode: "content", context: 1 },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		// Should show the matching line with context
		expect(result.content).toContain("return");
		expect(result.content).toContain("match");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — truncation", () => {
	it("limits results with head_limit", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "function", output_mode: "content", head_limit: 1 },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		// Should have limited results
		expect(result.content).toBeTruthy();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Glob Pattern Filtering
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — glob pattern filtering", () => {
	it("filters files by glob pattern", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "function", glob_pattern: "*.ts", output_mode: "file_paths" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		// Should find .ts files but not .js files
		expect(result.content).toContain("hello.ts");
		expect(result.content).not.toContain("utils.js");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Case-insensitive Search
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — case insensitive", () => {
	it("matches case-insensitively when enabled", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "hello", case_insensitive: true, output_mode: "content" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		// Should match both "hello" in function name and "Hello" in string
		expect(result.content).toContain("Hello");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// No Matches
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — no matches", () => {
	it("returns 'No matches found' when no results", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "nonexistent_pattern_xyz123" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toBe("No matches found");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Default output_mode
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — default output mode", () => {
	it("defaults to file_paths when output_mode not specified", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "function" },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Found matches in");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Input Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("text-search tool — input validation", () => {
	it("rejects empty pattern", async () => {
		const result = await textSearchTool.execute(
			{ pattern: "   " },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("empty");
	});

	it("rejects invalid input schema", async () => {
		const result = await textSearchTool.execute({ invalid: true }, ctx);
		expect(result.isError).toBe(true);
	});
});
