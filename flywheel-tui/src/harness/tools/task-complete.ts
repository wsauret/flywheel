/**
 * Task completion signal tool.
 *
 * Validates the worker handoff payload against WorkerHandoffSchema and
 * signals that the agent considers its task complete. The actual
 * double-confirm state machine logic lives outside this tool (in
 * completion.ts, Phase 4) — this tool only validates and signals intent.
 */

import { WorkerHandoffSchema } from "../../queue/shared/handoff-schemas.js";
import type { ConcurrencyMode, HarnessTool, ToolContext, ToolResult } from "./types.js";

async function execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
	const parsed = WorkerHandoffSchema.safeParse(input);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map(issue => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		return {
			content: `Handoff validation failed:\n${issues}\n\nFix the issues above and call task_complete again.`,
			isError: true,
		};
	}

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
	inputSchema: WorkerHandoffSchema,
	concurrency: "exclusive" as ConcurrencyMode,
	execute,
};
