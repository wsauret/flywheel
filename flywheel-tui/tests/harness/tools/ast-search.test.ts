import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { astSearchTool } from "../../../src/harness/tools/ast-search.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-search-test-"));
	ctx = { cwd: tmpDir, env: {} };

	// Create TypeScript test fixtures
	await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
	await fs.writeFile(
		path.join(tmpDir, "src", "hello.ts"),
		[
			'import { something } from "module";',
			"",
			"export function hello(name: string): string {",
			'  return `Hello, ${name}!`;',
			"}",
			"",
			"export function goodbye(name: string): string {",
			'  return `Goodbye, ${name}!`;',
			"}",
			"",
			"const CONSTANT = 42;",
		].join("\n"),
	);
	await fs.writeFile(
		path.join(tmpDir, "src", "utils.ts"),
		[
			"export function capitalize(str: string): string {",
			"  return str.charAt(0).toUpperCase() + str.slice(1);",
			"}",
			"",
			"export function lowercase(str: string): string {",
			"  return str.toLowerCase();",
			"}",
		].join("\n"),
	);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pattern Matching on TypeScript Code
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — pattern matching", () => {
	it("finds function declarations in TypeScript files", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "function $NAME($$$ARGS): $RET { $$$BODY }",
				language: "typescript",
				path: path.join(tmpDir, "src", "hello.ts"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello");
		expect(result.content).toContain("goodbye");
	});

	it("finds export function declarations", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "export function $NAME($$$ARGS): $RET { $$$BODY }",
				language: "typescript",
				path: path.join(tmpDir, "src"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("match");
		expect(result.content).toContain("hello");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Metavariable Capture
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — metavariable capture", () => {
	it("captures metavariables from pattern matches", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "const $NAME = $VALUE",
				language: "typescript",
				path: path.join(tmpDir, "src", "hello.ts"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("CONSTANT");
		expect(result.content).toContain("42");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Language Filter
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — language filter", () => {
	it("searches with explicit language specification", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "function $NAME($$$ARGS): $RET { $$$BODY }",
				language: "ts",
				path: path.join(tmpDir, "src"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("match");
	});

	it("infers language from file extension", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "function $NAME($$$ARGS): $RET { $$$BODY }",
				path: path.join(tmpDir, "src", "hello.ts"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("hello");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// No Matches
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — no matches", () => {
	it("returns 'No matches found' when no results", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "class $NAME extends $PARENT { $$$BODY }",
				language: "typescript",
				path: path.join(tmpDir, "src"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toBe("No matches found");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — error handling", () => {
	it("returns error for nonexistent path", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "function $NAME()",
				path: path.join(tmpDir, "nonexistent"),
			},
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	it("returns error for unrecognized language on a single file", async () => {
		await fs.writeFile(path.join(tmpDir, "data.xyz"), "some content");
		const result = await astSearchTool.execute(
			{
				pattern: "something",
				path: path.join(tmpDir, "data.xyz"),
			},
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("language");
	});

	it("rejects empty pattern", async () => {
		const result = await astSearchTool.execute(
			{ pattern: "   " },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("empty");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Directory Search
// ═══════════════════════════════════════════════════════════════════════════

describe("ast-search tool — directory search", () => {
	it("searches all matching files in a directory", async () => {
		const result = await astSearchTool.execute(
			{
				pattern: "function $NAME($$$ARGS): $RET { $$$BODY }",
				language: "typescript",
				path: path.join(tmpDir, "src"),
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		// Should find functions in both hello.ts and utils.ts
		expect(result.content).toContain("hello.ts");
		expect(result.content).toContain("utils.ts");
	});
});
