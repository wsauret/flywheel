import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computeLineHash, formatLineTag } from "../../../src/harness/tools/hashline.js";
import { editTool } from "../../../src/harness/tools/edit.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-tool-test-"));
	ctx = { cwd: tmpDir, env: {} };
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpFile(name: string): string {
	return path.join(tmpDir, name);
}

async function writeFile(name: string, content: string): Promise<string> {
	const filePath = tmpFile(name);
	await fs.writeFile(filePath, content);
	return filePath;
}

async function readFile(filePath: string): Promise<string> {
	return fs.readFile(filePath, "utf-8");
}

function tagFor(content: string, lineNumber: number): string {
	const lines = content.split("\n");
	const line = lines[lineNumber - 1]!;
	return `${lineNumber}#${computeLineHash(lineNumber, line)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// insert_before
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — insert_before", () => {
	it("inserts lines before the target through the tool interface", async () => {
		const content = "line one\nline two\nline three";
		const filePath = await writeFile("test.txt", content);
		const target = tagFor(content, 2);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "insert_before", target, lines: ["inserted"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated.split("\n")[1]).toBe("inserted");
		expect(updated.split("\n")[2]).toBe("line two");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// insert_after
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — insert_after", () => {
	it("inserts lines after the target through the tool interface", async () => {
		const content = "line one\nline two\nline three";
		const filePath = await writeFile("test.txt", content);
		const target = tagFor(content, 2);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "insert_after", target, lines: ["inserted"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated.split("\n")[2]).toBe("inserted");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// replace
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — replace", () => {
	it("replaces a range of lines", async () => {
		const content = "line one\nline two\nline three\nline four";
		const filePath = await writeFile("test.txt", content);
		const start = tagFor(content, 2);
		const end = tagFor(content, 3);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "replace", start, end, lines: ["replacement"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated.split("\n")).toEqual(["line one", "replacement", "line four"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// delete
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — delete", () => {
	it("deletes a range of lines", async () => {
		const content = "line one\nline two\nline three\nline four";
		const filePath = await writeFile("test.txt", content);
		const start = tagFor(content, 2);
		const end = tagFor(content, 3);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "delete", start, end }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated.split("\n")).toEqual(["line one", "line four"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// replace_all
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — replace_all", () => {
	it("replaces entire file content", async () => {
		const content = "line one\nline two\nline three";
		const filePath = await writeFile("test.txt", content);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "replace_all", lines: ["new content", "second line"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated).toBe("new content\nsecond line");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// create
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — create", () => {
	it("creates a new file via create operation", async () => {
		const filePath = tmpFile("new-file.txt");

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "create", lines: ["brand new", "file content"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		expect(result.content).toContain("Created");
		const created = await readFile(filePath);
		expect(created).toBe("brand new\nfile content");
	});

	it("creates nested directories for the new file", async () => {
		const filePath = path.join(tmpDir, "nested", "dir", "file.txt");

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "create", lines: ["hello"] }] },
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const created = await readFile(filePath);
		expect(created).toBe("hello");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Hash validation and mismatch reporting
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — hash validation", () => {
	it("returns error result for stale hash", async () => {
		const content = "first\nsecond\nthird";
		const filePath = await writeFile("mismatch.txt", content);

		const result = await editTool.execute(
			{ file_path: filePath, edits: [{ op: "insert_after", target: "2#ZZ", lines: ["new"] }] },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("changed");
		expect(result.content).toContain(">>>");
	});

	it("returns error for file not found", async () => {
		const result = await editTool.execute(
			{ file_path: "/nonexistent/file.txt", edits: [{ op: "insert_after", target: "1#ZZ", lines: ["x"] }] },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Bottom-up ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — bottom-up ordering", () => {
	it("applies multiple edits in correct order", async () => {
		const content = "a\nb\nc\nd\ne";
		const filePath = await writeFile("order.txt", content);
		const tag2 = tagFor(content, 2);
		const tag4 = tagFor(content, 4);

		const result = await editTool.execute(
			{
				file_path: filePath,
				edits: [
					{ op: "insert_after", target: tag2, lines: ["after-b"] },
					{ op: "insert_after", target: tag4, lines: ["after-d"] },
				],
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		expect(updated.split("\n")).toEqual(["a", "b", "after-b", "c", "d", "after-d", "e"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Prefix stripping
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — prefix stripping", () => {
	it("strips hashline prefixes from edit lines that the model accidentally copied", async () => {
		const content = "line one\nline two\nline three";
		const filePath = await writeFile("prefix.txt", content);

		const result = await editTool.execute(
			{
				file_path: filePath,
				edits: [
					{
						op: "replace_all",
						lines: ["1#KX:clean content", "2#ZP:also clean"],
					},
				],
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const updated = await readFile(filePath);
		// Prefixes should be stripped
		expect(updated).toBe("clean content\nalso clean");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Input validation
// ═══════════════════════════════════════════════════════════════════════════

describe("edit tool — input validation", () => {
	it("rejects invalid input schema", async () => {
		const result = await editTool.execute({ invalid: true }, ctx);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Invalid input");
	});

	it("rejects empty edits array", async () => {
		const filePath = await writeFile("empty-edits.txt", "content");
		const result = await editTool.execute({ file_path: filePath, edits: [] }, ctx);
		expect(result.isError).toBe(true);
	});
});
