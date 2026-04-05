/**
 * Hashline-addressed edit tool.
 *
 * Applies structured edits to files using line-number + hash references
 * for integrity. All six edit operations (insert_before, insert_after,
 * replace, delete, replace_all, create) are delegated to applyHashlineEdits.
 */

import * as fs from "node:fs/promises";
import { z } from "zod";
import {
	applyHashlineEdits,
	formatHashLines,
	hashlineEditSchema,
	HashlineMismatchError,
	stripHashlinePrefixes,
} from "./hashline.js";
import type { ConcurrencyMode, HarnessTool, ToolContext, ToolResult } from "./types.js";

const editInputSchema = z.object({
	file_path: z.string().describe("Absolute or relative path to the file to edit"),
	edits: z
		.array(hashlineEditSchema)
		.min(1)
		.describe("Array of hashline edit operations to apply transactionally"),
});

async function execute(input: unknown, context: ToolContext): Promise<ToolResult> {
	const parsed = editInputSchema.safeParse(input);
	if (!parsed.success) {
		return { content: `Invalid input: ${parsed.error.message}`, isError: true };
	}

	const { file_path, edits } = parsed.data;
	const resolvedPath = file_path.startsWith("/") ? file_path : `${context.cwd}/${file_path}`;

	// For create operations, the file shouldn't exist yet
	const hasCreate = edits.some(e => e.op === "create");
	if (!hasCreate) {
		// Verify file exists before proceeding
		try {
			await fs.access(resolvedPath);
		} catch {
			return { content: `File not found: ${file_path}`, isError: true };
		}
	}

	// Read the file content to strip prefixes from edit lines
	const strippedEdits = edits.map(edit => {
		if ("lines" in edit && edit.lines) {
			const joined = edit.lines.join("\n");
			const stripped = stripHashlinePrefixes(joined);
			return { ...edit, lines: stripped.split("\n") };
		}
		return edit;
	});

	try {
		await applyHashlineEdits(resolvedPath, strippedEdits);
	} catch (err) {
		if (err instanceof HashlineMismatchError) {
			return { content: err.message, isError: true };
		}
		if (err instanceof Error) {
			return { content: err.message, isError: true };
		}
		return { content: String(err), isError: true };
	}

	// Build summary of changes
	if (hasCreate) {
		return { content: `Created ${file_path}` };
	}

	const hasReplaceAll = edits.some(e => e.op === "replace_all");
	if (hasReplaceAll) {
		return { content: `Replaced all content in ${file_path}` };
	}

	// Read updated file and show it with hashlines for context
	try {
		const updated = await fs.readFile(resolvedPath, "utf-8");
		const preview = formatHashLines(updated);
		const lineCount = updated.split("\n").length;
		const editSummary = edits
			.map(e => e.op)
			.join(", ");
		return {
			content: `Applied ${edits.length} edit(s) to ${file_path} [${editSummary}] (${lineCount} lines)\n\n${preview}`,
		};
	} catch {
		return { content: `Applied ${edits.length} edit(s) to ${file_path}` };
	}
}

export const editTool: HarnessTool = {
	name: "edit",
	description:
		"Edit a file using hashline-addressed operations. Supports insert_before, insert_after, replace, delete, replace_all, and create. All edits are validated transactionally — if any hash mismatch is found, no changes are written.",
	inputSchema: editInputSchema,
	concurrency: "exclusive" as ConcurrencyMode,
	execute,
};
