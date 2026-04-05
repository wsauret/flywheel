import { describe, expect, it } from "bun:test";
import { taskCompleteTool } from "../../../src/harness/tools/task-complete.js";
import type { ToolContext } from "../../../src/harness/tools/types.js";

const ctx: ToolContext = { cwd: "/tmp", env: {} };

// ═══════════════════════════════════════════════════════════════════════════
// Valid Handoff
// ═══════════════════════════════════════════════════════════════════════════

describe("task-complete tool — valid handoff", () => {
	it("accepts a valid handoff with required fields", async () => {
		const result = await taskCompleteTool.execute(
			{
				summary: "Implemented the feature successfully and verified it works end to end.",
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content);
		expect(parsed.status).toBe("completion_requested");
		expect(parsed.summary).toContain("Implemented");
	});

	it("accepts a valid handoff with all optional fields", async () => {
		const result = await taskCompleteTool.execute(
			{
				summary: "Completed the refactoring of the authentication module with full test coverage.",
				artifacts: {
					files_created: ["src/auth.ts"],
					files_modified: ["src/app.ts"],
					commands_run: ["bun test"],
				},
				verification: {
					tests_passed: true,
					test_output_summary: "All 15 tests passed successfully with 100% coverage.",
				},
				decisions: ["Used JWT for token management"],
				warnings: ["Consider adding rate limiting in production"],
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content);
		expect(parsed.status).toBe("completion_requested");
		expect(parsed.artifacts).toBeTruthy();
		expect(parsed.verification).toBeTruthy();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Invalid Handoff
// ═══════════════════════════════════════════════════════════════════════════

describe("task-complete tool — invalid handoff", () => {
	it("rejects handoff with missing summary", async () => {
		const result = await taskCompleteTool.execute({}, ctx);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("validation failed");
	});

	it("rejects short summary (WorkerHandoffSchema enforces 20-char minimum)", async () => {
		const result = await taskCompleteTool.execute(
			{ summary: "Done" },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("validation failed");
	});

	it("rejects handoff with non-string summary", async () => {
		const result = await taskCompleteTool.execute(
			{ summary: 123 },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("summary");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Schema Validation on Both Calls
// ═══════════════════════════════════════════════════════════════════════════

describe("task-complete tool — schema validation consistency", () => {
	it("validates schema on first call (completion intent)", async () => {
		const result = await taskCompleteTool.execute(
			{
				summary: "Completed the initial implementation phase with all tests passing and code reviewed.",
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content);
		expect(parsed.status).toBe("completion_requested");
	});

	it("validates schema on second call identically (confirm completion)", async () => {
		// Second call with the same valid payload should also validate and succeed
		const result = await taskCompleteTool.execute(
			{
				summary: "Confirmed: all changes verified and ready for merge after double-checking all requirements.",
			},
			ctx,
		);

		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content);
		expect(parsed.status).toBe("completion_requested");
	});

	it("rejects invalid handoff on both first and second calls", async () => {
		// Missing summary entirely
		const result1 = await taskCompleteTool.execute({}, ctx);
		expect(result1.isError).toBe(true);

		const result2 = await taskCompleteTool.execute({}, ctx);
		expect(result2.isError).toBe(true);
	});
});
