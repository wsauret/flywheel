import { Schema } from "effect";
import type { MutationEvidence } from "./mutation-evidence.js";

/** Files whose change a mutating command made but Flywheel kept out of the
 *  project, each with the plain reason a reader sees, such as "binary files are
 *  not merged". The project file stays as it was. */
export const NotAppliedFilesSchema = Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String }));

export type NotAppliedFile = (typeof NotAppliedFilesSchema.Type)[number];

export interface NotAppliedFilesSummary {
  readonly total: number;
  readonly samples: readonly NotAppliedFile[];
}

export interface FileSamplesSummary {
  readonly total: number;
  readonly samples: readonly string[];
}

/** Format only a bounded sample. The manifest owns the complete file list. */
export function formatFileSamples(summary: FileSamplesSummary, options: { kind?: "changed" | "not-applied" | "mixed"; audience?: "model" | "client" } = {}): string {
  const listed = summary.samples.join(", ");
  const remainder = summary.total - summary.samples.length;
  const destination = options.audience !== "client" ? "" : options.kind === "not-applied" || options.kind === "mixed" ? " (expand this result)" : " (open Session Changes)";
  const kind = options.kind === "not-applied" ? "not-applied " : "";
  return remainder === 0 ? listed : `${listed}${listed ? ", " : ""}and ${remainder} more ${kind}file${remainder === 1 ? "" : "s"}${destination}`;
}

/** The changed items a one-line summary of `evidence` names: each removed directory once, in
 *  place of the files it held. `name` chooses how a path reads. */
export function mutationEvidenceItems(evidence: MutationEvidence, name: (path: string) => string = path => path): FileSamplesSummary {
  return {
    total: evidence.applied + evidence.notApplied + (evidence.unknownChanges ?? 0) - (evidence.filesInRemovedDirectories ?? 0) + (evidence.removedDirectories ?? 0),
    samples: evidence.samples.map(sample => sample.kind === "removed_directory"
      ? `${name(sample.path)}/ (${sample.files} file${sample.files === 1 ? "" : "s"})` : name(sample.path)),
  };
}

/** Share the same conflict notice between command reports and client surfaces. */
export function formatConflictMarkers(summary: FileSamplesSummary, audience: "model" | "client" = "model"): string {
  return `Flywheel added conflict markers where the project changed the same lines as the command: ${formatFileSamples(summary, { audience })}`;
}

/** Keep conflict samples within the same display envelope as refusal samples. */
export function summarizeFileSamples(paths: readonly string[]): FileSamplesSummary {
  const samples: string[] = [];
  const summary = { total: paths.length, samples };
  const encoder = new TextEncoder();
  for (const path of paths) {
    if (summary.samples.length === 3) break;
    if (encoder.encode(JSON.stringify({ total: paths.length, samples: [...summary.samples, path] })).byteLength <= 2048) summary.samples.push(path);
  }
  return summary;
}

/** Keep at most three display-only samples within the complete encoded envelope.
 * The exact total never depends on how many paths fit. */
export function summarizeNotAppliedFiles(files: readonly NotAppliedFile[], maxBytes = 2048): NotAppliedFilesSummary {
  const samples: NotAppliedFile[] = [];
  const summary = { total: files.length, samples };
  const encoder = new TextEncoder();
  if (encoder.encode(JSON.stringify(summary)).byteLength > maxBytes) throw new Error("Not-applied summary budget is too small");
  for (const file of files) {
    if (samples.length === 3) break;
    if (encoder.encode(JSON.stringify({ total: files.length, samples: [...samples, file] })).byteLength <= maxBytes) samples.push(file);
  }
  return summary;
}

/** Preserve the small-list notice wording. Samples are display metadata, not Undo authority. */
export function formatNotAppliedFiles(summary: NotAppliedFilesSummary, audience: "model" | "client" = "model"): string {
  return `Not applied, because the project also changed these files: ${formatFileSamples({ total: summary.total, samples: summary.samples.map(file => `${file.path} (${file.reason})`) }, { kind: "not-applied", audience })}`;
}

