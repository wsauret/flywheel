import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { ContentEvidence } from "../infra/content-evidence.js";
import { sanitizeExternalText } from "../infra/control-characters.js";
import type { LearningScope } from "../infra/learning-scope.js";

/** The body file of every skill package, bundled or installed. */
export const SKILL_FILE = "SKILL.md";

/** The catalog carries every installed trigger as its author wrote it,
 *  flattened to one line, because the catalog is the only discovery surface
 *  that reaches the model without a tool call. Flywheel bounds only what it
 *  writes itself: this creation budget keeps the always-loaded catalog small
 *  for Flywheel-managed skills. Admission (`SKILL_LIMITS`) bounds the catalog,
 *  and a person controls the cost of third-party packages by uninstalling
 *  them. */
export const NEW_SKILL_TRIGGER_MAX_CHARS = 60;

/** Who vouches for a package. Bundled packages ship inside Flywheel, so a
 *  malformed one is a build bug. External packages are third-party artifacts
 *  the user installed: their metadata, bodies, and file trees are untrusted
 *  input and a bad install must never break startup. */
export type SkillAuthority = "bundled" | "external";

/** Where the package bytes live, which also decides how a resource read is
 *  served: filesystem packages are read from disk under containment rules,
 *  manifest packages are compiled into the binary and carry their files. Both
 *  carry the reach of the store they came from, so every consumer reads the
 *  scope decision off the package instead of re-deriving it from a path. */
export type SkillSource = FilesystemSkillSource | ManifestSkillSource;

/** A filesystem package bound to the directory it was loaded from. Every read
 *  of the package, body and resources alike, is anchored here and never at the
 *  configured path an installer can repoint. */
export interface SkillPackageBinding {
  /** Package directory with every symlink resolved, bound once at load. */
  readonly canonicalDir: string;
  /** `dev:ino` of `canonicalDir` at load. A read re-opens the root and refuses
   *  when the identity changed, so replacing the package directory, or any
   *  directory above it, cannot redirect a read into another tree. */
  readonly canonicalId: string;
  /** The package entry in its skill root is a link to `canonicalDir`. Such a
   *  package loads, but Flywheel's skill writes never pass through the link
   *  (ARCH-BOUNDARIES-008). A linked root does not make its packages linked. */
  readonly linked: boolean;
}

interface FilesystemSkillSource extends SkillPackageBinding {
  readonly kind: "filesystem";
  readonly authority: SkillAuthority;
  /** Reach of the store this package is installed in (ARCH-LEARNING-005).
   *  Independent of authority and of `managed`: a global package can be
   *  user-authored, and a project package can be Flywheel-managed. */
  readonly reach: LearningScope;
  /** Package directory as configured: skill root plus package name. Kept for
   *  local diagnostics and for the package name the context header renders;
   *  never opened, because the binding above is what a read is rooted in. */
  readonly packageDir: string;
  /** The module definition bundle this package came from, by contribution
   *  id. Availability requires that module for the package (ARCH-STRUCTURE-031). Absent
   *  for Flywheel's own bundled roots and every external root. */
  readonly bundle?: string;
}

interface ManifestSkillSource {
  readonly kind: "manifest";
  readonly authority: "bundled";
  /** Bundled packages ship inside Flywheel, so they follow the user into
   *  every project. */
  readonly reach: "global";
  readonly packageKey: string;
  /** The module definition bundle this package came from, as for a filesystem package. */
  readonly bundle?: string;

  /** Package-relative path to file text, including `SKILL.md`. */
  readonly files: ReadonlyMap<string, string>;
}

/** Admission limits for one load. External packages are untrusted artifacts of
 *  any size, so a package that exceeds a limit is refused whole and named:
 *  nothing here truncates a body or a resource manifest, because a half
 *  procedure is worse than an absent one. */
/** Write-time budget for one `SKILL.md` body, in characters.
 *
 *  The same two-tier shape as the trigger above. `SKILL_LIMITS.bodyBytes`
 *  (64,000) is the loader's admission ceiling: what a package may be before it
 *  is refused as unreadable. This is the far tighter budget a writer must fit,
 *  and it exists for a different reason. A body enters the model's context in
 *  full every time the skill is selected, while a file under `references/`
 *  costs one manifest line until something asks for it. So the body is the
 *  expensive tier and the one that needs a budget.
 *
 *  12,000 is measured, not chosen: across the 36 bundled skills, which are
 *  hand-authored and known to work, the median body is about 5,400 characters
 *  and 30 of 36 already fit this. It is generous enough that an ordinary skill
 *  never meets it, and tight enough to catch the ones that hurt.
 *
 *  A package already over the budget is not force-migrated. It may only shrink
 *  (see `planSkillMutation`), so a library drains as its skills are edited
 *  rather than in one migration, exactly as the trigger budget converges. */
export const SKILL_BODY_BUDGET_CHARS = 12_000;

/** Bundled bodies that one load must carry whole, by skill id, each at its
 *  measured size so it may only shrink. The global budget assumes that detail
 *  moves to `references/`, which costs a turn only when a reader asks for it.
 *  A body listed here is the exception: its readers ask for that detail on
 *  every load, so a separate file costs a tool call each time instead of
 *  never. Only bundled authority reads this table; an external package with
 *  the same id keeps the global budget. */
const BUNDLED_SKILL_BODY_BUDGETS: ReadonlyMap<string, number> = new Map([
  // One body saves a tool call on every authoring turn.
  ["workflow-authoring", 22_487],
]);

/** The body budget of one package: its bundled exception, or the global budget. */
export function skillBodyBudgetChars(skill: Pick<SkillDefinition, "id" | "source">): number {
  return (skill.source.authority === "bundled" ? BUNDLED_SKILL_BODY_BUDGETS.get(skill.id) : undefined) ?? SKILL_BODY_BUDGET_CHARS;
}

/** Extra space a refusal asks a writer to free, beyond the deficit itself.
 *
 *  Measured from a real cleanup: when the instruction was "get under the
 *  limit", writers landed at 11,982 and 11,954 of 12,000, which is one added
 *  paragraph away from being refused again. Freeing only the deficit hands the
 *  next writer the same problem. 500 characters is about one paragraph, so the
 *  next ordinary edit fits without another round of demotion. */
export const SKILL_BODY_HEADROOM_CHARS = 500;

/** Share of the body budget above which a load says what to do about it.
 *
 *  Stating use alone is not enough, and can make things worse. A writer shown
 *  "88%" with no instruction compressed its own new content to squeak under,
 *  dropping a convention the rest of the file kept, and left the body at 98%
 *  with the next writer certain to be refused. That is the budget causing
 *  damage rather than preventing it. Above this share a load names the move
 *  that actually helps, so the writer takes it before it writes rather than
 *  discovering it in a refusal it may never trigger. */
export const SKILL_BODY_CROWDED_SHARE = 0.75;

export const SKILL_LIMITS = {
  /** External packages admitted per load, across every root. */
  packages: 256,
  /** Frontmatter block of one package, markers included. */
  metadataBytes: 8_192,
  /** `SKILL.md` body of one package. */
  bodyBytes: 64_000,
  /** Resource files one package may declare. */
  resources: 128,
  /** Directory entries one load examines before it refuses what it is reading:
   *  a package walk counts every entry of every directory it descends, and a
   *  skill root counts its own. Declared and skipped entries count alike, so a
   *  directory of symlinks buys no more work than a directory of files. A
   *  package that organizes the maximum number of resources in subdirectories
   *  stays well inside it. */
  scanEntries: 1_024,
  /** Declared resource paths of one package, which the context header lists. */
  resourceManifestBytes: 4_096,
  /** Every file of one package together: `SKILL.md` as installed plus every
   *  resource it declares. A package is admitted whole, so this is the one
   *  total a load and a write both apply; the limits above bound what one file
   *  may be, never what a package adds up to. */
  packageBytes: 1_048_576,
} as const;

/** A package file the skill may load on demand. Declared once at load time; a
 *  path outside this list is never read. */
export interface SkillResource {
  /** Package-relative POSIX path, for example `references/api.md`. */
  readonly path: string;
  readonly bytes: number;
}

/** Every admitted byte of one package. */
export function admittedPackageBytes(skillFileBytes: number, resources: readonly SkillResource[]): number {
  return resources.reduce((total, resource) => total + resource.bytes, skillFileBytes);
}

/** The refusal for a package over the one total admission bound, or undefined
 *  when it fits. The loader throws it and the write store returns it, so a
 *  package is measured by the same rule wherever it is admitted. */
export function packageOverLimit(bytes: number): string | undefined {
  if (bytes <= SKILL_LIMITS.packageBytes) return undefined;
  return `Package totals ${bytes} bytes, over the ${SKILL_LIMITS.packageBytes}-byte admission limit; a package is admitted whole, so shorten or remove its files.`;
}

/** Cap on the `SKILL.md` file of one package of this authority, or undefined
 *  when the whole-package total is its only bound. An external package is an
 *  untrusted artifact of any size, so its body and frontmatter are bounded file
 *  by file. A bundled package is Flywheel's own build artifact, reviewed in this
 *  repository and compiled into the manifest: the manifest admits it by the
 *  package total alone, so the filesystem read of the same package holds to the
 *  same rule instead of refusing in a source tree what the binary serves. */
export function skillFileByteCap(authority: SkillAuthority): number | undefined {
  return authority === "bundled" ? undefined : SKILL_LIMITS.metadataBytes + SKILL_LIMITS.bodyBytes;
}

/** Content identity of one whole package: `SKILL.md` and every declared
 *  resource, path, length, and content alike, in one deterministic order. It
 *  is computed once when the package is admitted and owned by the revision
 *  that publishes it, so a consumer names the exact package it was served
 *  without opening a resource again. Two packages with the same digest hold
 *  the same files with the same bytes under the same paths. */
export interface SkillPackageIdentity {
  readonly sha256: string;
  /** Admitted bytes: `SKILL.md` as installed plus every declared resource. */
  readonly bytes: number;
}

/** One exact file in a bundled package. Content and byte length are retained so
 * semantic audits never reopen a mutable package directory. */
interface BundledSkillFile {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
}

/** One canonical package in the bundled audit corpus, including packages that
 * an external install shadows in the selected catalog. */
export interface BundledSkillPackage {
  readonly id: string;
  /** Architectural owner. Excluded from package identity. */
  readonly sourceKind: import("./skill-source-inventory.js").BundledSkillSourceKind;
  readonly authority: "bundled";
  readonly files: readonly BundledSkillFile[];
  readonly packageIdentity: SkillPackageIdentity;
}

/** Versioned identity of the complete immutable bundled skill corpus. */
export interface BundledCorpusIdentity {
  readonly version: 1;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SkillPackageManifestEntry {
  readonly id: string;
  readonly packageIdentity: SkillPackageIdentity;
}

const BUNDLED_CORPUS_DIGEST_DOMAIN = "flywheel-bundled-skill-corpus/1\n";

/** Identify a package manifest in canonical id order with the corpus digest framing. */
export function skillPackageManifestIdentity(manifest: readonly SkillPackageManifestEntry[]): BundledCorpusIdentity {
  const digest = createHash("sha256").update(BUNDLED_CORPUS_DIGEST_DOMAIN);
  let bytes = 0;
  for (const skill of [...manifest].sort((left, right) => left.id.localeCompare(right.id))) {
    const idBytes = Buffer.byteLength(skill.id, "utf8");
    digest.update(`${idBytes}\n`).update(skill.id, "utf8").update(`\n${skill.packageIdentity.sha256}\n${skill.packageIdentity.bytes}\n`);
    bytes += skill.packageIdentity.bytes;
  }
  return { version: 1, sha256: digest.digest("hex"), bytes };
}

/** Identify every bundled package in canonical id order. Each id is byte-length
 * framed before the exact package digest and admitted byte count. */
export function bundledCorpusIdentity(corpus: ReadonlyMap<string, BundledSkillPackage>): BundledCorpusIdentity {
  return skillPackageManifestIdentity([...corpus.values()].map(({ id, packageIdentity }) => ({ id, packageIdentity })));
}

/** A lazy context package: the trigger is advertised, the body is loaded only
 *  when the package is selected. */
export interface SkillDefinition {
  /** Qualified skill id (see infra/skill-id.ts). Unique across the catalog. */
  readonly id: string;
  readonly name: string;
  /** Frontmatter `description`: the routing surface, advertised without the body. */
  readonly trigger: string;
  readonly version?: string;
  readonly tags: readonly string[];
  /** Ids of skills this package points at. Not resolved here. */
  readonly relatedIds: readonly string[];
  /** Ids of skills whose context is composed into this skill's prompt before
   *  its own body, in declaration order. Deterministic: no model decides
   *  whether the procedure is loaded. Resolved transitively (see
   *  skill-closure.ts). */
  readonly dependencies: readonly string[];
  /** Persona names this skill's body may dispatch. An agent of a workflow receives
   *  them as compiled subagent slots; direct invocation renders them as a
   *  catalog for the chat agent's own `subagent` tool. */
  readonly agents: readonly string[];
  /** What a direct invocation reports in chat when it completes. Absent means
   *  the skill's body already says what it produces. A workflow-owned
   *  package is never invoked directly, so it declares none. */
  readonly directOutput?: string;
  /** The persona that runs this method in Flywheel. A delegated package is
   *  composed by that persona's `requiredSkills` and is not model-invocable
   *  in chat here; the persona registry warns when the delegate does not
   *  compose it, because the method is then unreachable. */
  readonly delegate?: string;
  /** The method needs a person who reads the conversation: it asks that
   *  person or waits for approval. Every agent of an unattended chat's tree
   *  leaves it, and each skill that composes it, out of its catalog and
   *  refuses to load them (PI-AGENT-121). */
  readonly attended?: true;
  readonly modelInvocable: boolean;
  /** `SKILL.md` body, byte-for-byte as authored. */
  readonly body: string;
  /** Content identity of `body`: sha256 plus byte count. */
  readonly evidence: ContentEvidence;
  /** Content identity of the whole package, `SKILL.md` and resources alike. */
  readonly packageIdentity: SkillPackageIdentity;
  readonly resources: readonly SkillResource[];
  /** Write contract of a managed package; absent means writes are refused. */
  readonly managed?: "flywheel" | "user";
  /** Sessions that created and last updated a managed package. */
  readonly provenance?: SkillProvenance;
  readonly source: SkillSource;
  /** The package of the same id that this one outranked, when there was one. */
  readonly shadowed?: ShadowedPackage;
}

/** The lower-precedence package of one id: its source, reach included, and its
 *  own whole-package identity. A conflict is therefore inspectable from the
 *  selected definition alone, with no read of the loser's directory. */
export interface ShadowedPackage {
  readonly source: SkillSource;
  readonly packageIdentity: SkillPackageIdentity;
}

/** One published snapshot of the skill registry. A revision is never mutated:
 *  a reload publishes the next one, and a failed reload keeps the last valid
 *  one. Every view a consumer needs is derived here, once per publication. */
export interface SkillRegistryRevision {
  readonly revision: number;
  readonly skills: ReadonlyMap<string, SkillDefinition>;
  /** Exact bundled packages admitted by the load that published this revision. */
  readonly bundledCorpus: ReadonlyMap<string, BundledSkillPackage>;
  /** Production packages owned by the agent-skill root. */
  readonly corePackages: ReadonlyMap<string, BundledSkillPackage>;
  /** Canonical production core package identities, sorted by id. */
  readonly coreManifest: readonly Readonly<SkillPackageManifestEntry>[];
  readonly coreIdentity: BundledCorpusIdentity;
  /** Versioned exact identity derived from every bundled corpus entry. */
  readonly bundledCorpusIdentity: BundledCorpusIdentity;
  /** Model-invocable packages of this revision, sorted by id: the catalog the
   *  prompt advertises in full. A package that sets `disable-model-invocation`
   *  is authored for humans only and is absent here, while `skills` still
   *  holds it for slash commands and `requiredSkills`. */
  readonly modelInvocable: readonly SkillDefinition[];
}

/** Publish one revision with its derived views resolved and frozen, so no
 *  consumer filters or sorts the catalog again per model turn or tool call.
 *  The catalog is copied out of `skills`, so the map the caller keeps loading
 *  into cannot change what was published. */
export function publishSkillRevision(
  revision: number,
  skills: ReadonlyMap<string, SkillDefinition>,
  bundledCorpus: ReadonlyMap<string, BundledSkillPackage> = new Map(),
): SkillRegistryRevision {
  const catalog = sealCatalog(skills);
  const corpus = sealReadonlyMap(bundledCorpus);
  const corpusIdentity = bundledCorpusIdentity(corpus);
  const corePackages = sealReadonlyMap(new Map([...corpus].filter(([, pkg]) => pkg.sourceKind === "agent")));
  const coreManifest = Object.freeze([...corePackages.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, packageIdentity }) => Object.freeze({ id, packageIdentity })));
  const coreIdentity = bundledCorpusIdentity(corePackages);
  const modelInvocable = [...catalog.values()]
    .filter((skill) => skill.modelInvocable)
    .sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({ revision, skills: catalog, bundledCorpus: corpus, bundledCorpusIdentity: corpusIdentity, corePackages, coreManifest, coreIdentity, modelInvocable: Object.freeze(modelInvocable) });
}

/** A read-only catalog with no mutator to reach. A frozen `Map` still accepts
 *  `set` and `delete`, so a revision that held one would change under every
 *  consumer that already read it as soon as anything cast it back to `Map`.
 *  This view holds the only reference to its entries and exposes no way to
 *  write them, which is what "a revision is never mutated" has to mean. */
function sealCatalog(skills: ReadonlyMap<string, SkillDefinition>): ReadonlyMap<string, SkillDefinition> {
  return sealReadonlyMap(skills);
}

function sealReadonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const entries = new Map(source);
  const catalog: ReadonlyMap<K, V> = Object.freeze({
    size: entries.size,
    get: (key: K) => entries.get(key),
    has: (key: K) => entries.has(key),
    keys: () => entries.keys(),
    values: () => entries.values(),
    entries: () => entries.entries(),
    forEach: (visit: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      for (const [key, value] of entries) visit.call(thisArg, value, key, catalog);
    },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  });
  return catalog;
}

/** Cross-harness Agent Skills frontmatter. This is an external boundary:
 *  packages are authored for other harnesses, so unknown fields (allowed-tools,
 *  model, license, compatibility, ...) are ignored and recoverable variation
 *  (a YAML number version, a comma-separated tag string) is normalized here,
 *  once. */
const TextList = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

const SkillFrontmatterSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  tags: Schema.optionalKey(TextList),
  related: Schema.optionalKey(TextList),
  // `aliases` and `user-invocable` are cross-harness keys that third-party
  // packs carry. They are accepted and ignored: skills are agent methods, and
  // no person types a skill as a command.
  aliases: Schema.optionalKey(TextList),
  "user-invocable": Schema.optionalKey(Schema.Boolean),
  dependencies: Schema.optionalKey(TextList),
  agents: Schema.optionalKey(TextList),
  "direct-output": Schema.optionalKey(Schema.String),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
  // Flywheel's own field: the persona that runs this method here, so chat
  // agents delegate instead of loading it. Another harness has no such agent
  // and ignores the key, so the same package stays invocable there.
  delegate: Schema.optionalKey(Schema.String),
  // Flywheel's own field: the method needs a person who reads the
  // conversation, because it asks that person or waits for approval. Another
  // harness ignores the key.
  attended: Schema.optionalKey(Schema.Boolean),
  // Flywheel's own write-contract fields, not cross-harness ones. Typed loose
  // because hand edits are legal and a malformed marker must not unpublish the
  // package: normalization degrades it to absent, and an unmarked package
  // refuses writes, so the degradation fails closed.
  managed: Schema.optionalKey(Schema.Unknown),
  provenance: Schema.optionalKey(Schema.Unknown),
});

/** Which sessions wrote a managed package. Advisory metadata: the typed
 *  `skill.written` facts are the audit trail, this is the copy a reader of the
 *  file sees without the event store. */
interface SkillProvenance {
  readonly createdBy?: string;
  readonly updatedBy?: string;
}

export interface SkillMetadata {
  readonly name: string | undefined;
  readonly trigger: string;
  readonly version: string | undefined;
  readonly tags: readonly string[];
  readonly relatedIds: readonly string[];
  readonly dependencies: readonly string[];
  readonly agents: readonly string[];
  readonly directOutput: string | undefined;
  readonly delegate: string | undefined;
  readonly attended: boolean;
  readonly modelInvocable: boolean;
  /** The write contract: `flywheel` accepts autonomous review writes, `user`
   *  is pinned to user-directed writes, absent refuses every write. */
  readonly managed: "flywheel" | "user" | undefined;
  readonly provenance: SkillProvenance | undefined;
}

interface SkillFrontmatterInput {
  readonly [key: string]: unknown;
}

/** Normalize one package's frontmatter into Flywheel's canonical metadata.
 *  Throws when the package cannot be advertised at all, which is the only
 *  frontmatter failure: a missing or empty `description` leaves nothing to
 *  route on. */
export function normalizeSkillFrontmatter(raw: SkillFrontmatterInput): SkillMetadata {
  const frontmatter = Schema.decodeUnknownSync(SkillFrontmatterSchema)(raw);
  const trigger = oneLine(frontmatter.description ?? "");
  if (!trigger) throw new Error('frontmatter is missing the required "description"');
  const delegate = oneLine(frontmatter.delegate ?? "") || undefined;

  return {
    name: oneLine(frontmatter.name ?? "") || undefined,
    trigger,
    version: oneLine(typeof frontmatter.version === "number" ? String(frontmatter.version) : frontmatter.version ?? "") || undefined,
    tags: toList(frontmatter.tags),
    relatedIds: toList(frontmatter.related),
    dependencies: toList(frontmatter.dependencies),
    agents: toList(frontmatter.agents),
    directOutput: multiLine(frontmatter["direct-output"] ?? "") || undefined,
    delegate,
    attended: frontmatter.attended ?? false,
    modelInvocable: delegate === undefined && !(frontmatter["disable-model-invocation"] ?? false),
    managed: frontmatter.managed === "flywheel" || frontmatter.managed === "user" ? frontmatter.managed : undefined,
    provenance: toProvenance(frontmatter.provenance),
  };
}

interface ParsedProvenance {
  readonly createdBy?: unknown;
  readonly updatedBy?: unknown;
}

function toProvenance(value: unknown): SkillProvenance | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parsed: ParsedProvenance = value;
  const field = (raw: unknown): string | undefined =>
    typeof raw === "string" ? oneLine(raw) || undefined : undefined;
  const createdBy = field(parsed.createdBy);
  const updatedBy = field(parsed.updatedBy);
  if (createdBy === undefined && updatedBy === undefined) return undefined;
  return { ...(createdBy ? { createdBy } : {}), ...(updatedBy ? { updatedBy } : {}) };
}

/** Metadata reaches the model as one line per package in the system prompt
 *  catalog. A package authored for another harness may legitimately
 *  wrap its description over several YAML lines, so the text is flattened
 *  rather than refused: escape sequences and control characters are dropped and
 *  every run of whitespace becomes one space. A description can then say
 *  anything it likes and still be one line of data, never a line break that
 *  makes the next sentence read as its own prompt instruction. */
function oneLine(text: string): string {
  return sanitizeExternalText(text).replace(/\s+/gu, " ").trim();
}

/** Prompt-bound package text, kept as authored apart from control characters.
 *  A direct-output contract is several sentences of instruction, so unlike the
 *  one-line routing metadata it keeps its own line structure. */
function multiLine(text: string): string {
  return sanitizeExternalText(text).trim();
}

function toList(value: string | readonly string[] | undefined): readonly string[] {
  const items = value === undefined ? [] : typeof value === "string" ? value.split(",") : value;
  return items.map((item) => oneLine(item)).filter((item) => item.length > 0);
}
