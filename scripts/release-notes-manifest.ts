export interface ReleaseNotesManifest {
  readonly schemaVersion: 1;
  readonly surface: "terminal" | "vscode";
  readonly releaseVersion: string;
  readonly head: string;
  readonly baseTag: string | null;
  readonly notesSha256: string;
}

export interface ReleaseNotesIdentity {
  readonly surface: "terminal" | "vscode";
  readonly releaseVersion: string;
  readonly head: string;
  readonly baseTag: string | undefined;
}

export function releaseNotesSha256(notes: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(notes);
  return hasher.digest("hex");
}

export function createReleaseNotesManifest(identity: ReleaseNotesIdentity, notes: string): ReleaseNotesManifest {
  return {
    schemaVersion: 1,
    surface: identity.surface,
    releaseVersion: identity.releaseVersion,
    head: identity.head,
    baseTag: identity.baseTag ?? null,
    notesSha256: releaseNotesSha256(notes),
  };
}

export function releaseNotesManifestViolation(
  value: unknown,
  expected: ReleaseNotesIdentity,
  notes: string,
): string | undefined {
  if (typeof value !== "object" || value === null) return "release-notes.json is not an object";
  if (!("schemaVersion" in value) || value.schemaVersion !== 1) return "release-notes.json has an unsupported schema version";
  if (!("surface" in value) || value.surface !== expected.surface) return `release-notes.json is for ${"surface" in value ? String(value.surface) : "an unknown surface"}, not ${expected.surface}`;
  if (!("releaseVersion" in value) || value.releaseVersion !== expected.releaseVersion) {
    return `release-notes.json is for version ${"releaseVersion" in value ? String(value.releaseVersion) : "unknown"}, not ${expected.releaseVersion}`;
  }
  if (!("head" in value) || value.head !== expected.head) return "release-notes.json was generated from another source commit";
  if (!("baseTag" in value) || value.baseTag !== (expected.baseTag ?? null)) return "release-notes.json was generated from another release boundary";
  if (!("notesSha256" in value) || value.notesSha256 !== releaseNotesSha256(notes)) return "release-notes.md does not match release-notes.json";
  return undefined;
}
