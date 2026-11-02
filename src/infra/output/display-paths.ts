import type { MutationDiff } from "../mutation-diff.js";
import type { ProvisionalDiff } from "../output-blocks.js";
import type { MutationEvidence, MutationEvidenceEntry } from "../mutation-evidence.js";
import { formatRelativePath } from "../tools/detail-helpers.js";

function relativePath(path: string, executionCwd: string): string {
  return formatRelativePath(path, executionCwd) ?? path;
}

/** Derive presentation without changing the canonical settlement identity. */
export function mutationEvidenceDisplayPaths(entry: MutationEvidenceEntry, executionCwd: string): MutationEvidenceEntry {
  if (entry.kind === "applied") return { ...entry, file: { ...entry.file, displayPath: relativePath(entry.file.path, executionCwd) } };
  if (entry.kind === "display") return { ...entry, file: { ...entry.file, displayPath: relativePath(entry.file.path, executionCwd) } };
  return entry.kind === "omitted" || entry.kind === "removed_directory" ? { ...entry, displayPath: relativePath(entry.path, executionCwd) } : entry;
}

/** Only the capped samples are presentation paths. The manifest identity stays unchanged. */
export function mutationEvidenceSummaryDisplayPaths(evidence: MutationEvidence, executionCwd: string): MutationEvidence {
  return { ...evidence, samples: evidence.samples.map(sample => ({ ...sample, path: relativePath(sample.path, executionCwd) })) };
}

/** Project canonical mutation evidence into the path form shown to a user. */
export function mutationDisplayPaths(mutation: MutationDiff, executionCwd: string): MutationDiff {
  return {
    ...mutation,
    files: mutation.files.map(file => ({ ...file, path: relativePath(file.path, executionCwd) })),
    omissions: mutation.omissions.map(omission => ({ ...omission, path: relativePath(omission.path, executionCwd) })),
  };
}

/** Project streamed or settled proposal paths without changing their file ids. */
export function provisionalDiffDisplayPaths(diff: ProvisionalDiff, executionCwd: string): ProvisionalDiff {
  return {
    ...diff,
    files: diff.files.map(file => ({
      ...file,
      ...(file.path !== undefined ? { path: relativePath(file.path, executionCwd) } : {}),
      ...(file.movePath !== undefined ? { movePath: relativePath(file.movePath, executionCwd) } : {}),
    })),
  };
}
