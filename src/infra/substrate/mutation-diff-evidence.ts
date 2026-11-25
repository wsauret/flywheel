import { mutationDiffLineCounts, type MutationDiff } from "./mutation-diff.js"
import { buildMutationEvidence, type MutationEvidence, type MutationEvidenceEntry } from "./mutation-evidence.js"
import { buildSessionContent, type StageSessionContentNodes } from "./session-content.js"

type DisplayEntry = Extract<MutationEvidenceEntry, { kind: "display" | "omitted" }>

/** Stage an already-retained display diff without reconstructing endpoint content.
 * The descriptors provide no filesystem or Undo authority. Storage failures reject. */
export async function buildMutationDiffEvidence(
  diff: MutationDiff,
  mutationId: string,
  stage: StageSessionContentNodes,
): Promise<MutationEvidence> {
  return buildMutationEvidence(await buildMutationDiffEntries(diff, mutationId, stage), stage)
}

/** Retained historical patches have display authority only, without invented endpoints. */
export async function buildMutationDiffEntries(
  diff: MutationDiff,
  mutationId: string,
  stage: StageSessionContentNodes,
): Promise<DisplayEntry[]> {
  const entries: DisplayEntry[] = []
  for (const file of diff.files) {
    const counts = mutationDiffLineCounts(file.unifiedDiff)
    const omittedLines = file.omittedLines ?? 0
    entries.push({
      kind: "display",
      file: {
        version: 1, mutationId, path: file.path, displayPath: file.path,
        change: file.change,
        retainedLines: counts.rendered, renderedLines: counts.rendered + omittedLines, omittedLines,
        addedLines: counts.added, removedLines: counts.removed, conflictMarkers: false,
        patch: { kind: "retained", reference: await buildSessionContent(file.unifiedDiff, stage) },
      },
    })
  }
  for (const omission of diff.omissions) {
    entries.push({
      kind: "omitted", path: omission.path, displayPath: omission.path, reason: omission.reason,
    })
  }
  return entries
}
