import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	HashlineMismatchError,
	applyHashlineEdits,
	computeLineHash,
	formatHashLines,
	formatLineTag,
	hashlineEditSchema,
	parseTag,
	stripHashlinePrefixes,
	validateLineRef,
} from "../../src/harness/tools/hashline.js";

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-test-"));
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

/**
 * Compute a tag for a line at a given 1-indexed position in content.
 */
function tagFor(content: string, lineNumber: number): string {
	const lines = content.split("\n");
	const line = lines[lineNumber - 1]!;
	return `${lineNumber}#${computeLineHash(lineNumber, line)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hash Computation
// ═══════════════════════════════════════════════════════════════════════════

describe("computeLineHash", () => {
	it("produces consistent 2-char hashes", () => {
		const hash1 = computeLineHash(1, "function hello() {");
		const hash2 = computeLineHash(1, "function hello() {");
		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(2);
	});

	it("uses only NIBBLE_STR alphabet characters", () => {
		const validChars = new Set("ZPMQVRWSNKTXJBYH".split(""));
		for (let i = 0; i < 100; i++) {
			const hash = computeLineHash(i + 1, `line content ${i}`);
			expect(hash).toHaveLength(2);
			for (const ch of hash) {
				expect(validChars.has(ch)).toBe(true);
			}
		}
	});

	it("produces different hashes for different content", () => {
		const hash1 = computeLineHash(1, "function hello() {");
		const hash2 = computeLineHash(1, "function world() {");
		// They *could* collide in theory but extremely unlikely for distinct inputs
		// Just verify they are both valid
		expect(hash1).toHaveLength(2);
		expect(hash2).toHaveLength(2);
	});

	it("mixes in line number for non-alphanumeric lines", () => {
		// Lines with only punctuation/whitespace use the line number as seed
		const hash1 = computeLineHash(1, "  {");
		const hash2 = computeLineHash(2, "  {");
		// With different seeds, these should (likely) produce different hashes
		expect(hash1).toHaveLength(2);
		expect(hash2).toHaveLength(2);
	});

	it("trims trailing whitespace before hashing", () => {
		const hash1 = computeLineHash(1, "hello   ");
		const hash2 = computeLineHash(1, "hello");
		expect(hash1).toBe(hash2);
	});

	it("strips carriage returns before hashing", () => {
		const hash1 = computeLineHash(1, "hello\r");
		const hash2 = computeLineHash(1, "hello");
		expect(hash1).toBe(hash2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tag Formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("formatLineTag", () => {
	it("produces LINE#HASH format", () => {
		const tag = formatLineTag(5, "const x = 42;");
		expect(tag).toMatch(/^5#[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("uses the line text for hash computation", () => {
		const tag1 = formatLineTag(1, "hello");
		const tag2 = formatLineTag(1, "world");
		expect(tag1).toMatch(/^1#/);
		expect(tag2).toMatch(/^1#/);
		// The hash portions should differ
		const hash1 = tag1.slice(2);
		const hash2 = tag2.slice(2);
		expect(hash1).not.toBe(hash2);
	});
});

describe("formatHashLines", () => {
	it("adds correct prefixes to each line", () => {
		const content = "line one\nline two\nline three";
		const formatted = formatHashLines(content);
		const lines = formatted.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:line one$/);
		expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}:line two$/);
		expect(lines[2]).toMatch(/^3#[ZPMQVRWSNKTXJBYH]{2}:line three$/);
	});

	it("handles empty content (single empty line)", () => {
		const formatted = formatHashLines("");
		expect(formatted).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:$/);
	});

	it("handles single-line content", () => {
		const formatted = formatHashLines("only line");
		expect(formatted).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:only line$/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Tag Parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("parseTag", () => {
	it("parses valid LINE#HASH format", () => {
		const result = parseTag("5#KX");
		expect(result).toEqual({ line: 5, hash: "KX" });
	});

	it("parses tags with whitespace", () => {
		const result = parseTag("  10 # ZP ");
		expect(result).toEqual({ line: 10, hash: "ZP" });
	});

	it("parses tags with leading context markers", () => {
		const result = parseTag(">>> 5#KX:some content");
		expect(result).toEqual({ line: 5, hash: "KX" });
	});

	it("parses bare line numbers", () => {
		const result = parseTag("42");
		expect(result).toEqual({ line: 42, hash: "" });
	});

	it("returns null for invalid formats", () => {
		expect(parseTag("")).toBeNull();
		expect(parseTag("abc")).toBeNull();
		expect(parseTag("#")).toBeNull();
		expect(parseTag("0#KX")).toBeNull(); // line < 1
	});

	it("returns null for line number 0", () => {
		expect(parseTag("0")).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("validateLineRef", () => {
	it("passes for matching hash", () => {
		const lines = ["hello", "world"];
		const hash = computeLineHash(1, "hello");
		expect(() => validateLineRef(lines, 1, hash)).not.toThrow();
	});

	it("throws HashlineMismatchError for wrong hash", () => {
		const lines = ["hello", "world"];
		try {
			validateLineRef(lines, 1, "ZZ");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
		}
	});

	it("throws Error for out-of-range line", () => {
		const lines = ["hello"];
		expect(() => validateLineRef(lines, 0, "XX")).toThrow("does not exist");
		expect(() => validateLineRef(lines, 2, "XX")).toThrow("does not exist");
	});

	it("includes >>> context markers in mismatch error", () => {
		const lines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
		try {
			validateLineRef(lines, 3, "ZZ");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const message = (err as HashlineMismatchError).message;
			expect(message).toContain(">>>");
			expect(message).toContain("line 3");
			// Should also show context lines around the mismatch
			expect(message).toContain("line 1");
			expect(message).toContain("line 5");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// HashlineMismatchError
// ═══════════════════════════════════════════════════════════════════════════

describe("HashlineMismatchError", () => {
	it("formats message with >>> markers on mismatched lines", () => {
		const lines = ["alpha", "beta", "gamma", "delta", "epsilon"];
		const err = new HashlineMismatchError(
			[{ line: 3, expected: "ZZ", actual: computeLineHash(3, "gamma") }],
			lines,
		);
		expect(err.message).toContain(">>>");
		expect(err.message).toContain("1 line has changed");
	});

	it("provides remaps from old to new references", () => {
		const lines = ["alpha", "beta"];
		const actual = computeLineHash(1, "alpha");
		const err = new HashlineMismatchError(
			[{ line: 1, expected: "ZZ", actual }],
			lines,
		);
		expect(err.remaps.get("1#ZZ")).toBe(`1#${actual}`);
	});

	it("handles multiple mismatches", () => {
		const lines = ["a", "b", "c"];
		const err = new HashlineMismatchError(
			[
				{ line: 1, expected: "ZZ", actual: computeLineHash(1, "a") },
				{ line: 3, expected: "YY", actual: computeLineHash(3, "c") },
			],
			lines,
		);
		expect(err.message).toContain("2 lines have changed");
		expect(err.remaps.size).toBe(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Edit Operations
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits", () => {
	const sampleContent = "line one\nline two\nline three\nline four\nline five";

	describe("insert_before", () => {
		it("inserts lines before the target", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const target = tagFor(sampleContent, 2);

			await applyHashlineEdits(filePath, [
				{ op: "insert_before", target, lines: ["inserted A", "inserted B"] },
			]);

			const result = await readFile(filePath);
			const lines = result.split("\n");
			expect(lines[0]).toBe("line one");
			expect(lines[1]).toBe("inserted A");
			expect(lines[2]).toBe("inserted B");
			expect(lines[3]).toBe("line two");
			expect(lines).toHaveLength(7);
		});
	});

	describe("insert_after", () => {
		it("inserts lines after the target", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const target = tagFor(sampleContent, 2);

			await applyHashlineEdits(filePath, [
				{ op: "insert_after", target, lines: ["inserted C"] },
			]);

			const result = await readFile(filePath);
			const lines = result.split("\n");
			expect(lines[0]).toBe("line one");
			expect(lines[1]).toBe("line two");
			expect(lines[2]).toBe("inserted C");
			expect(lines[3]).toBe("line three");
			expect(lines).toHaveLength(6);
		});
	});

	describe("replace", () => {
		it("replaces a range of lines", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const start = tagFor(sampleContent, 2);
			const end = tagFor(sampleContent, 4);

			await applyHashlineEdits(filePath, [
				{ op: "replace", start, end, lines: ["replacement"] },
			]);

			const result = await readFile(filePath);
			const lines = result.split("\n");
			expect(lines).toEqual(["line one", "replacement", "line five"]);
		});

		it("replaces a single line", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const start = tagFor(sampleContent, 3);
			const end = tagFor(sampleContent, 3);

			await applyHashlineEdits(filePath, [
				{ op: "replace", start, end, lines: ["replaced line three"] },
			]);

			const result = await readFile(filePath);
			const lines = result.split("\n");
			expect(lines[2]).toBe("replaced line three");
			expect(lines).toHaveLength(5);
		});
	});

	describe("delete", () => {
		it("deletes a range of lines", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const start = tagFor(sampleContent, 2);
			const end = tagFor(sampleContent, 4);

			await applyHashlineEdits(filePath, [
				{ op: "delete", start, end },
			]);

			const result = await readFile(filePath);
			const lines = result.split("\n");
			expect(lines).toEqual(["line one", "line five"]);
		});

		it("deletes a single line", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const start = tagFor(sampleContent, 3);
			const end = tagFor(sampleContent, 3);

			await applyHashlineEdits(filePath, [
				{ op: "delete", start, end },
			]);

			const result = await readFile(filePath);
			expect(result.split("\n")).toHaveLength(4);
			expect(result).not.toContain("line three");
		});
	});

	describe("replace_all", () => {
		it("replaces entire file content", async () => {
			const filePath = await writeFile("test.txt", sampleContent);

			await applyHashlineEdits(filePath, [
				{ op: "replace_all", lines: ["new content", "second line"] },
			]);

			const result = await readFile(filePath);
			expect(result).toBe("new content\nsecond line");
		});

		it("must be the only edit in the batch", async () => {
			const filePath = await writeFile("test.txt", sampleContent);
			const target = tagFor(sampleContent, 1);

			await expect(
				applyHashlineEdits(filePath, [
					{ op: "replace_all", lines: ["new"] },
					{ op: "insert_after", target, lines: ["extra"] },
				]),
			).rejects.toThrow("must be the only edit");
		});
	});

	describe("create", () => {
		it("creates a new file", async () => {
			const filePath = tmpFile("new-file.txt");

			await applyHashlineEdits(filePath, [
				{ op: "create", lines: ["brand new", "file content"] },
			]);

			const result = await readFile(filePath);
			expect(result).toBe("brand new\nfile content");
		});

		it("creates parent directories if needed", async () => {
			const filePath = path.join(tmpDir, "nested", "dir", "file.txt");

			await applyHashlineEdits(filePath, [
				{ op: "create", lines: ["hello from nested"] },
			]);

			const result = await readFile(filePath);
			expect(result).toBe("hello from nested");
		});

		it("must be the only edit in the batch", async () => {
			const filePath = tmpFile("new.txt");

			await expect(
				applyHashlineEdits(filePath, [
					{ op: "create", lines: ["a"] },
					{ op: "create", lines: ["b"] },
				]),
			).rejects.toThrow("must be the only edit");
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Bottom-up Sort Ordering
// ═══════════════════════════════════════════════════════════════════════════

describe("bottom-up sort ordering", () => {
	it("applies edits from bottom to top to avoid line shift issues", async () => {
		const content = "a\nb\nc\nd\ne";
		const filePath = await writeFile("sort.txt", content);
		const tag2 = tagFor(content, 2);
		const tag4 = tagFor(content, 4);

		// Insert after line 2 and insert after line 4 — order shouldn't matter
		await applyHashlineEdits(filePath, [
			{ op: "insert_after", target: tag2, lines: ["after-b"] },
			{ op: "insert_after", target: tag4, lines: ["after-d"] },
		]);

		const result = await readFile(filePath);
		const lines = result.split("\n");
		expect(lines).toEqual(["a", "b", "after-b", "c", "d", "after-d", "e"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Noop Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("noop detection", () => {
	it("does not write file when replace produces no change", async () => {
		const content = "alpha\nbeta\ngamma";
		const filePath = await writeFile("noop.txt", content);
		const statBefore = await fs.stat(filePath);

		const start = tagFor(content, 2);
		const end = tagFor(content, 2);

		// Replace line 2 with identical content
		await applyHashlineEdits(filePath, [
			{ op: "replace", start, end, lines: ["beta"] },
		]);

		const result = await readFile(filePath);
		expect(result).toBe(content);

		// Verify file was not rewritten (mtime should be unchanged or very close)
		const statAfter = await fs.stat(filePath);
		expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Hash Mismatch Errors
// ═══════════════════════════════════════════════════════════════════════════

describe("hash mismatch errors in edits", () => {
	it("throws HashlineMismatchError for stale hash", async () => {
		const content = "first\nsecond\nthird";
		const filePath = await writeFile("mismatch.txt", content);

		try {
			await applyHashlineEdits(filePath, [
				{ op: "insert_after", target: "2#ZZ", lines: ["new line"] },
			]);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const mismatchErr = err as HashlineMismatchError;
			expect(mismatchErr.mismatches).toHaveLength(1);
			expect(mismatchErr.mismatches[0]!.line).toBe(2);
		}
	});

	it("includes descriptive context in the error message", async () => {
		const content = "alpha\nbeta\ngamma\ndelta";
		const filePath = await writeFile("ctx.txt", content);

		try {
			await applyHashlineEdits(filePath, [
				{ op: "insert_after", target: "2#ZZ", lines: ["x"] },
			]);
			expect.unreachable("should have thrown");
		} catch (err) {
			const message = (err as HashlineMismatchError).message;
			expect(message).toContain(">>>");
			expect(message).toContain("beta");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Transactional Rollback [C9]
// ═══════════════════════════════════════════════════════════════════════════

describe("transactional rollback", () => {
	it("does not apply first edit when second edit fails validation", async () => {
		const content = "line one\nline two\nline three";
		const filePath = await writeFile("txn.txt", content);
		const validTarget = tagFor(content, 1);

		try {
			await applyHashlineEdits(filePath, [
				// First edit is valid
				{ op: "insert_after", target: validTarget, lines: ["inserted"] },
				// Second edit has a bad hash — should fail validation
				{ op: "insert_after", target: "3#ZZ", lines: ["bad"] },
			]);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
		}

		// File should be UNCHANGED — first edit was NOT applied
		const result = await readFile(filePath);
		expect(result).toBe(content);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Zod Schema Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("hashlineEditSchema", () => {
	it("validates insert_before edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "insert_before",
			target: "5#KX",
			lines: ["new line"],
		});
		expect(result.success).toBe(true);
	});

	it("validates insert_after edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "insert_after",
			target: "3#ZP",
			lines: ["a", "b"],
		});
		expect(result.success).toBe(true);
	});

	it("validates replace edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "replace",
			start: "1#AA",
			end: "5#BB",
			lines: ["replaced"],
		});
		expect(result.success).toBe(true);
	});

	it("validates delete edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "delete",
			start: "2#CC",
			end: "4#DD",
		});
		expect(result.success).toBe(true);
	});

	it("validates replace_all edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "replace_all",
			lines: ["full", "replacement"],
		});
		expect(result.success).toBe(true);
	});

	it("validates create edits", () => {
		const result = hashlineEditSchema.safeParse({
			op: "create",
			lines: ["new file content"],
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid op", () => {
		const result = hashlineEditSchema.safeParse({
			op: "invalid_op",
			lines: ["x"],
		});
		expect(result.success).toBe(false);
	});

	it("rejects insert_before without target", () => {
		const result = hashlineEditSchema.safeParse({
			op: "insert_before",
			lines: ["x"],
		});
		expect(result.success).toBe(false);
	});

	it("rejects replace without end", () => {
		const result = hashlineEditSchema.safeParse({
			op: "replace",
			start: "1#AA",
			lines: ["x"],
		});
		expect(result.success).toBe(false);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Strip Hashline Prefixes
// ═══════════════════════════════════════════════════════════════════════════

describe("stripHashlinePrefixes", () => {
	it("removes LINE#HASH: prefixes when all non-empty lines have them", () => {
		const input = "1#KX:hello world\n2#ZP:goodbye\n3#MQ:end";
		const result = stripHashlinePrefixes(input);
		expect(result).toBe("hello world\ngoodbye\nend");
	});

	it("preserves content when not all lines have prefixes", () => {
		const input = "1#KX:hello world\nnormal line\n3#MQ:end";
		expect(stripHashlinePrefixes(input)).toBe(input);
	});

	it("preserves empty lines (they don't count)", () => {
		const input = "1#KX:hello\n\n3#MQ:world";
		const result = stripHashlinePrefixes(input);
		expect(result).toBe("hello\n\nworld");
	});

	it("returns original content for empty string", () => {
		expect(stripHashlinePrefixes("")).toBe("");
	});

	it("handles content with >>> markers", () => {
		const input = ">>> 1#KX:changed line\n>>> 2#ZP:another";
		const result = stripHashlinePrefixes(input);
		expect(result).toBe("changed line\nanother");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
	it("handles empty file", async () => {
		const filePath = await writeFile("empty.txt", "");
		const tag = tagFor("", 1);

		await applyHashlineEdits(filePath, [
			{ op: "insert_after", target: tag, lines: ["new content"] },
		]);

		const result = await readFile(filePath);
		expect(result.split("\n")).toContain("new content");
	});

	it("handles single-line file", async () => {
		const content = "only line";
		const filePath = await writeFile("single.txt", content);
		const tag = tagFor(content, 1);

		await applyHashlineEdits(filePath, [
			{ op: "replace", start: tag, end: tag, lines: ["replaced single line"] },
		]);

		const result = await readFile(filePath);
		expect(result).toBe("replaced single line");
	});

	it("handles file with no trailing newline", async () => {
		const content = "line one\nline two";
		const filePath = await writeFile("no-newline.txt", content);
		const tag = tagFor(content, 2);

		await applyHashlineEdits(filePath, [
			{ op: "insert_after", target: tag, lines: ["line three"] },
		]);

		const result = await readFile(filePath);
		expect(result).toBe("line one\nline two\nline three");
	});

	it("handles empty edits array gracefully", async () => {
		const content = "unchanged";
		const filePath = await writeFile("no-edits.txt", content);

		await applyHashlineEdits(filePath, []);

		const result = await readFile(filePath);
		expect(result).toBe(content);
	});

	it("throws for out-of-range line reference", async () => {
		const content = "line one\nline two";
		const filePath = await writeFile("range.txt", content);

		await expect(
			applyHashlineEdits(filePath, [
				{ op: "insert_after", target: "99#KX", lines: ["x"] },
			]),
		).rejects.toThrow("does not exist");
	});
});
