import { canonicalize } from "../canonical-name.js";

// A dash between numbers is a version separator (claude-opus-4-5 is 4.5) unless
// the number after it is a parameter size: 70b, 1.8b, 2.4t, or 8x22b.
const NUMERIC_DASH_SEPARATOR_RE = /(\d)-(?=\d+(?!\d|[bmtk](?![a-z])|x\d|\.\d))/gi;
// Remove after 2026-12-22 with the dotted-spelling branch of migrateLegacyModelSpellings: the rule releases
// used before 2026-09-22, which dotted parameter sizes (qwen3-8b as qwen3.8b).
const LEGACY_NUMERIC_DASH_SEPARATOR_RE = /(\d)-(?=\d)/g;
const NUMERIC_DOT_SEPARATOR_RE = /(\d)\.(?=\d)/g;
const DATE_SNAPSHOT_SUFFIX_RE = /(-(?:20\d{6}|\d{4}-\d{2}-\d{2}))(\s*)$/;
const GENERATION_PREFIX_RE = /^(\d+)(?:\.(\d+))?(?:-|$)/;

export interface ModelGeneration {
  readonly major: number;
  readonly minor: number;
}

export type ClaudeTokenizerIdentity = "ClaudeV3" | "ClaudeV47" | "ClaudeV5" | "ClaudeV5Sonnet";
export type CatalogDataUse = "standard" | "contributor";
export interface CanonicalCatalogModel {
  readonly modelId: string;
  readonly dataUse: CatalogDataUse;
}

/** Returns Flywheel's provider-neutral identity for model selection and routing. */
export function canonicalModelId(model: string): string {
  return migrateModelId(canonicalize(model));
}

/** Migrates persisted model spelling while preserving surrounding authored whitespace. */
export function migrateModelId(model: string): string {
  const match = model.match(DATE_SNAPSHOT_SUFFIX_RE);
  if (!match?.[1]) return dottedModelVersion(model);
  const trailingWhitespace = match[2] ?? "";
  return dottedModelVersion(model.slice(0, -match[0].length)) + trailingWhitespace;
}

/** Classifies a provider catalog wire without changing generic model identity. */
export function canonicalCatalogModelId(wireModelId: string): CanonicalCatalogModel {
  const marker = "-contributor";
  const contributor = wireModelId.endsWith(marker);
  return {
    modelId: canonicalModelId(contributor ? wireModelId.slice(0, -marker.length) : wireModelId),
    dataUse: contributor ? "contributor" : "standard",
  };
}

/** Moving provider aliases are routes, not stable model identities. */
export function isMovingModelAlias(wireModelId: string): boolean {
  return wireModelId.charCodeAt(0) === 126;
}

/** Parses the generation that follows a canonical model-family prefix. */
export function parseCanonicalModelGeneration(canonicalModel: string, canonicalFamily: string): ModelGeneration | undefined {
  const prefix = `${canonicalFamily}-`;
  if (!canonicalModel.startsWith(prefix)) return undefined;
  const match = canonicalModel.slice(prefix.length).match(GENERATION_PREFIX_RE);
  if (!match?.[1]) return undefined;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

/** Uses dotted numeric versions without changing any other model-id bytes. */
export function dottedModelVersion(model: string): string {
  const dateSuffix = model.match(DATE_SNAPSHOT_SUFFIX_RE)?.[0] ?? "";
  const stem = dateSuffix ? model.slice(0, -dateSuffix.length) : model;
  return stem.replace(NUMERIC_DASH_SEPARATOR_RE, "$1.") + dateSuffix;
}

/** Returns the spelling releases before 2026-09-22 saved for a canonical model
 *  identity. Remove after 2026-12-22 with the dotted-spelling branch of
 *  migrateLegacyModelSpellings. */
export function legacyDottedModelId(model: string): string {
  const dateSuffix = model.match(DATE_SNAPSHOT_SUFFIX_RE)?.[0] ?? "";
  const stem = dateSuffix ? model.slice(0, -dateSuffix.length) : model;
  return stem.replace(LEGACY_NUMERIC_DASH_SEPARATOR_RE, "$1.") + dateSuffix;
}

/** Returns a provider-facing dashed version from a canonical model identity. */
export function dashedModelId(model: string): string {
  return canonicalize(model).replace(NUMERIC_DOT_SEPARATOR_RE, "$1-");
}

/** Chooses one observed provider spelling without depending on catalog order. */
export function preferredWireModelId(left: string, right: string): string {
  const leftSnapshot = terminalSnapshot(left);
  const rightSnapshot = terminalSnapshot(right);
  if (leftSnapshot === undefined && rightSnapshot !== undefined) return left;
  if (rightSnapshot === undefined && leftSnapshot !== undefined) return right;
  if (leftSnapshot !== undefined && rightSnapshot !== undefined && leftSnapshot !== rightSnapshot) {
    return leftSnapshot > rightSnapshot ? left : right;
  }
  return left <= right ? left : right;
}

/** Maps canonical model identities to exact provider spellings. */
export function canonicalWireModelMap(wireModelIds: Iterable<string>): ReadonlyMap<string, string> {
  // Identity only: this module sits in the protocol package's import closure,
  // which every browser client bundles, so it records no diagnostics. The
  // catalog resolution that owns collisions records them.
  const result = new Map<string, string>();
  for (const wireModelId of wireModelIds) {
    const canonical = canonicalModelId(wireModelId);
    const previous = result.get(canonical);
    result.set(canonical, previous === undefined ? wireModelId : preferredWireModelId(previous, wireModelId));
  }
  return result;
}

function terminalSnapshot(wireModelId: string): string | undefined {
  const contributorMarker = "-contributor";
  const classified = wireModelId.endsWith(contributorMarker)
    ? wireModelId.slice(0, -contributorMarker.length)
    : wireModelId;
  const suffix = classified.match(DATE_SNAPSHOT_SUFFIX_RE)?.[1];
  return suffix?.replaceAll("-", "");
}
