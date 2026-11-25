export type DefinitionLayer = "bundled" | "user" | "project";

export type DefinitionFamily = "skill" | "persona" | "system-prompt";

export interface DefinitionSource {
  readonly path: string;
  readonly layer: DefinitionLayer;
  readonly reach?: "global" | "project";
  readonly identity?: string;
}

export type DefinitionCandidate<T> =
  | { readonly kind: "valid"; readonly source: DefinitionSource; readonly value: T }
  | { readonly kind: "rejected"; readonly source: DefinitionSource; readonly reason: string };

export type DefinitionResolutionDiagnostic =
  | { readonly kind: "rejected"; readonly source: DefinitionSource; readonly reason: string }
  | { readonly kind: "masking"; readonly winner: DefinitionSource; readonly displaced: DefinitionSource };

/** One lossless precedence decision. Candidates are ordered from highest to lowest precedence. `target` is stable across source path changes. */
export interface DefinitionResolution<T> {
  readonly family: DefinitionFamily;
  readonly id: string;
  readonly target: string;
  readonly candidates: readonly DefinitionCandidate<T>[];
  readonly selected?: { readonly source: DefinitionSource; readonly value: T };
  readonly diagnostics: readonly DefinitionResolutionDiagnostic[];
}

export function resolveDefinitionCandidates<T>(
  family: DefinitionFamily,
  id: string,
  target: string,
  candidates: readonly DefinitionCandidate<T>[],
): DefinitionResolution<T> {
  const selectedCandidate = candidates.find((candidate) => candidate.kind === "valid");
  const selected = selectedCandidate?.kind === "valid"
    ? { source: selectedCandidate.source, value: selectedCandidate.value }
    : undefined;
  const diagnostics: DefinitionResolutionDiagnostic[] = candidates.flatMap((candidate) =>
    candidate.kind === "rejected" && candidate.source.layer !== "bundled"
      ? [{ kind: "rejected" as const, source: candidate.source, reason: candidate.reason }]
      : [],
  );
  if (selected) {
    const bundled = candidates.find((candidate) => candidate.kind === "valid" && candidate.source.layer === "bundled");
    if (selected.source.layer !== "bundled" && bundled?.kind === "valid") {
      diagnostics.push({ kind: "masking", winner: selected.source, displaced: bundled.source });
    }
  }
  return { family, id, target, candidates, ...(selected ? { selected } : {}), diagnostics };
}

const loggedMaskingDiagnostics = new Set<string>();

/** True once for each exact winning and displaced content pair in this process. */
export function shouldLogDefinitionMasking(diagnostic: Extract<DefinitionResolutionDiagnostic, { kind: "masking" }>): boolean {
  const key = JSON.stringify([diagnostic.winner.path, diagnostic.winner.identity, diagnostic.displaced.path, diagnostic.displaced.identity]);
  if (loggedMaskingDiagnostics.has(key)) return false;
  loggedMaskingDiagnostics.add(key);
  return true;
}
