/**
 * Task completion signal tool.
 *
 * Validates the worker handoff payload against WorkerHandoffSchema and
 * signals that the agent considers its task complete. The actual
 * double-confirm state machine logic lives outside this tool (in
 * completion.ts, Phase 4) — this tool only validates and signals intent.
 */

import { z } from "zod";
import { WorkerHandoffSchema } from "../../queue/shared/handoff-schemas.js";
import type { ConcurrencyMode, HarnessTool, ToolContext, ToolResult } from "./types.js";

const taskCompleteInputSchema = z.object({
  summary: z.string().describe("A concise paragraph describing what was accomplished (required, 20-5000 chars, no newlines, 1-10 sentences)"),
  artifacts: z.object({
    files_created: z.array(z.string()).optional(),
    files_modified: z.array(z.string()).optional(),
    commands_run: z.array(z.string()).optional(),
  }).optional().describe("Files created/modified and commands run"),
  verification: z.object({
    tests_passed: z.boolean().nullable(),
    test_output_summary: z.string().optional(),
  }).optional().describe("Whether tests pass and a summary of test output"),
  decisions: z.array(z.string()).optional().describe("Key decisions made during the task"),
  warnings: z.array(z.string()).optional().describe("Warnings or caveats about the work"),
});

async function execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
	const parsed = taskCompleteInputSchema.safeParse(input);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		return {
			content: `Handoff validation failed:\n${issues}\n\nFix the issues above and call task_complete again.`,
			isError: true,
		};
	}

	// Return a successful validation result. The completion state machine
	// (Phase 4) will intercept this and either inject a verification
	// checklist (first call) or confirm completion (second call).
	const handoff = parsed.data;
	return {
		content: JSON.stringify({
			status: "completion_requested",
			summary: handoff.summary,
			artifacts: handoff.artifacts ?? null,
			verification: handoff.verification ?? null,
		}),
	};
}

export const taskCompleteTool: HarnessTool = {
	name: "task_complete",
	description:
		"Signal that the current task is complete. Provide a structured handoff with a summary of what was accomplished, artifacts created/modified, and verification results. The handoff is validated against the WorkerHandoffSchema. On first call, a verification checklist will be returned — review it and call again to confirm.",
	inputSchema: taskCompleteInputSchema,
	concurrency: "exclusive" as ConcurrencyMode,
	execute,
};
