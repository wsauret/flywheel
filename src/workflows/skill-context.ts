import { createHash, type Hash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory, ContainedPathError } from "../infra/descriptor-directory.js";
import type { ContainedDirectoryContract, ContainedOwnedFile } from "../infra/descriptor-directory-contract.js";
import { renderCapabilityText, type CapabilityCheck } from "../infra/capability-text.js";
import type {
  SkillAuthority,
  SkillDefinition,
  SkillPackageBinding,
  SkillPackageIdentity,
  SkillResource,
} from "./skill-schema.js";
import { admittedPackageBytes, packageOverLimit, SKILL_FILE, SKILL_LIMITS, skillFileByteCap } from "./skill-schema.js";

/** Package trees are installed by the user, so the walk is bounded: a deep tree
 *  must not stall discovery or hot reload. */
const MAX_RESOURCE_DEPTH = 5;

/** A window is decoded strictly: package bytes that are not UTF-8 are refused
 *  rather than replaced, because a replacement character has a different byte
 *  length than the bytes it stands for and would shift every following page. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** One typed entry observed in a contained directory. A link is retained as a
 * candidate so binding can follow it, or report it when it names no
 * directory, instead of silently hiding an install. */
export interface SkillDirectoryEntry {
  readonly name: string;
  readonly type: "directory" | "file" | "symlink" | "other";
}

export type SkillDirectoryEntries = (directory: ContainedDirectoryContract) => Iterable<SkillDirectoryEntry>;

/** One skill root, opened for the duration of one scan. */
export interface ResolvedStepRoot {
  /** Child names, bounded by `limit`, with links retained as candidates. */
  readonly listPackageDirs: (limit: number) => readonly string[];
  /** Bind one listed child directory as a package root. */
  readonly bindPackage: (name: string) => SkillPackageBinding | undefined;
}

/** The contained authority exposes names and directory names separately. The
 * remaining entries are classified through metadata, without reading bytes. */
function containedEntries(directory: ContainedDirectoryContract): readonly SkillDirectoryEntry[] {
  const directories = new Set(directory.directoryEntryNames());
  const entries: SkillDirectoryEntry[] = [];
  for (const name of directory.entryNames()) {
    if (directories.has(name)) {
      entries.push({ name, type: "directory" });
      continue;
    }
    try {
      directory.regularFileModifiedAt(name);
      entries.push({ name, type: "file" });
    } catch (error) {
      if (isAbsentPath(error)) continue;
      if (error instanceof ContainedPathError) entries.push({ name, type: "symlink" });
      else throw error;
    }
  }
  return entries;
}

/** Scan one configured root through one contained directory window. */
export function withSkillRoot<T>(
  rootDir: string,
  use: (root: ResolvedStepRoot) => T,
  entriesOf: SkillDirectoryEntries = containedEntries,
): T {
  const root = ContainedDirectory.open(rootDir, []);
  try {
    return use({
      listPackageDirs: (limit) => listPackageDirs(root, rootDir, entriesOf, limit),
      bindPackage: (name) => bindPackage(root, rootDir, name),
    });
  } finally {
    root.close();
  }
}

function rootChanged(cause?: unknown): Error {
  return new Error("skill root changed while it was being read", cause === undefined ? undefined : { cause });
}

function listPackageDirs(
  root: ContainedDirectoryContract,
  rootDir: string,
  entriesOf: SkillDirectoryEntries,
  limit: number,
): readonly string[] {
  const names: string[] = [];
  let examined = 0;
  for (const entry of entriesOf(root)) {
    examined++;
    if (examined > SKILL_LIMITS.scanEntries) {
      throw new Error(`skill root holds more than ${SKILL_LIMITS.scanEntries} entries; move what is not a skill package out of the root`);
    }
    if (entry.type !== "directory" && entry.type !== "symlink") continue;
    if (entry.name.startsWith(".")) continue;
    names.push(entry.name);
    if (names.length >= limit) break;
  }
  try {
    root.requireSamePathAs(rootDir);
  } catch (error) {
    throw rootChanged(error);
  }
  return names.sort();
}

/** Bind one package entry. A directory installed in the root binds as itself.
 *  A link that a person placed in the root is followed once: its target is
 *  held as its own contained directory, the way a linked root is, and the
 *  package binds to the target's canonical path and identity, so every later
 *  read refuses a link below the package exactly as it does in an installed
 *  one. A link that names no directory is a package failure, never a skip. */
function bindPackage(root: ContainedDirectoryContract, rootDir: string, name: string): SkillPackageBinding | undefined {
  const packageDir = join(rootDir, name);
  let child: ContainedDirectoryContract | undefined;
  let linked = false;
  try {
    child = root.openExistingChild(name);
  } catch (error) {
    if (!(error instanceof ContainedPathError)) throw error;
    linked = true;
    try {
      child = ContainedDirectory.open(packageDir, []);
    } catch (cause) {
      throw new TypeError("package entry is a link that names no directory", { cause });
    }
  }
  if (child === undefined) return undefined;
  try {
    child.requireSamePathAs(packageDir);
    return { canonicalDir: child.canonicalPath(), canonicalId: child.identity(), linked };
  } finally {
    child.close();
  }
}

/** Bind the package directory at `dir`, or undefined when it is absent. The
 *  learning store reads and writes only the directories it owns, so a link at
 *  `dir` is refused rather than followed to a source Flywheel must not
 *  change. */
export function bindPackageDir(dir: string): SkillPackageBinding | undefined {
  let binding: SkillPackageBinding | undefined;
  try {
    binding = withSkillRoot(dirname(dir), (root) => root.bindPackage(basename(dir)));
  } catch (err) {
    if (isAbsentPath(err)) return undefined;
    throw err;
  }
  if (binding?.linked) throw new TypeError(`${dir} is a link; Flywheel does not read or write a store package through a link`);
  return binding;
}

/** One package's admitted bytes: the `SKILL.md` file as installed, frontmatter
 *  included, the files it declares beside it, and the identity of the whole. */
export interface SkillPackage {
  readonly skillFile: string;
  readonly resources: readonly SkillResource[];
  readonly identity: SkillPackageIdentity;
}

/** Take one compiled manifest package: the files the build compiled into the
 *  binary, declared and identified by the rules a filesystem package is
 *  admitted under. The body file is the package itself, not a resource.
 *  Throws when the package holds no `SKILL.md`, declares more files, or longer
 *  paths, than one package may advertise, a path no package may name, or more
 *  bytes than one package may hold. */
export function readManifestPackage(files: ReadonlyMap<string, string>): SkillPackage {
  const skillFile = files.get(SKILL_FILE);
  if (skillFile === undefined) throw new Error(`the package holds no ${SKILL_FILE}`);

  // One order for the manifest and for the digest: `sealResources` orders by
  // the same comparison, so the files fold in the order they are declared in.
  const declared = [...files].filter(([path]) => path !== SKILL_FILE && path !== ".base" && !path.startsWith(".base/")).sort(([a], [b]) => a.localeCompare(b));
  for (const [path] of declared) {
    for (const component of path.split("/")) assertSafePathComponent(component);
  }
  const resources = sealResources(declared.map(([path, text]) => ({ path, bytes: Buffer.byteLength(text, "utf8") })));
  const bytes = admitPackageBytes(skillFile, resources);

  const digest = openPackageDigest(skillFile);
  for (const [path, text] of declared) {
    foldFileHeader(digest, path, Buffer.byteLength(text, "utf8"));
    digest.update(text, "utf8");
  }
  return { skillFile, resources, identity: { sha256: digest.digest("hex"), bytes } };
}

/** Framing of the whole-package digest. Every file folds in its path and its
 *  length before its bytes, so no rename of a file, and no split or join of
 *  two of them, produces the digest of a package it is not. The version tag
 *  makes a later change of the framing a different identity, never a silent
 *  one. */
const PACKAGE_DIGEST_DOMAIN = "flywheel-skill-package/1\n";

/** Bytes are folded in bounded chunks after ContainedDirectory admits the whole package. */
const DIGEST_WINDOW_BYTES = 64 * 1024;

function openPackageDigest(skillFile: string): Hash {
  const digest = createHash("sha256").update(PACKAGE_DIGEST_DOMAIN);
  foldFileHeader(digest, SKILL_FILE, Buffer.byteLength(skillFile, "utf8"));
  return digest.update(skillFile, "utf8");
}

function foldFileHeader(digest: Hash, path: string, bytes: number): void {
  digest.update(`${path}\n${bytes}\n`);
}

/** The total one package is admitted by, or the refusal. A load and a write
 *  hold to the same total, and a package over it is refused by what its files
 *  measure, before one resource byte is read. */
function admitPackageBytes(skillFile: string, resources: readonly SkillResource[]): number {
  const bytes = admittedPackageBytes(Buffer.byteLength(skillFile, "utf8"), resources);
  const overLimit = packageOverLimit(bytes);
  if (overLimit) throw new Error(overLimit);
  return bytes;
}

/** Refuse a manifest larger than one package may advertise, then order it: the
 *  context header lists these paths, so two loads of one package list them the
 *  same way. */
function sealResources(resources: SkillResource[]): readonly SkillResource[] {
  if (resources.length > SKILL_LIMITS.resources) {
    throw new Error(`package declares more than ${SKILL_LIMITS.resources} resource files; remove files from the package directory`);
  }
  const manifestBytes = resources.reduce((total, resource) => total + Buffer.byteLength(resource.path, "utf8"), 0);
  if (manifestBytes > SKILL_LIMITS.resourceManifestBytes) {
    throw new Error(`resource paths total ${manifestBytes} bytes, over the ${SKILL_LIMITS.resourceManifestBytes}-byte limit; shorten or remove resource paths`);
  }

  return resources.sort((a, b) => a.path.localeCompare(b.path));
}

/** Control characters, C0 and C1 alike, and the Unicode line and paragraph
 *  separators: every character that ends a line of model-visible text. */
const UNSAFE_IN_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

/** Refuse a path component no package may declare. A resource path is
 *  model-visible outside any fence: the context header lists it on one line,
 *  and a tool call names it. A component carrying a line break or a control
 *  character would end that line and continue as text of its own, and a
 *  separator or dot form names something other than one entry of the package
 *  directory. The path is also the key a later read is served by, so it is
 *  refused here rather than rewritten into a path the package does not hold. */
function assertSafePathComponent(component: string): void {
  const unnameable = component === "" || component === "." || component === ".." || component.includes("/");
  if (unnameable || UNSAFE_IN_ONE_LINE.test(component)) {
    throw new Error(`resource path component ${escapeComponent(component)} is not one nameable entry of a package directory`);
  }
}

/** Name a refused component without reproducing what makes it unsafe: this
 *  message is logged and read by a person, and must stay one line. */
function escapeComponent(component: string): string {
  const escaped = component.replace(/[\p{Cc}\u2028\u2029"\\]/gu, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

/** One bounded window of a package resource, plus the size the resource had at
 *  read time. `content` decodes exactly the source bytes in
 *  `[offset, endOffset)`, so `endOffset` is the offset of the next window. */
export interface SkillResourceWindow {
  readonly content: string;
  readonly endOffset: number;
  readonly totalBytes: number;
}

/** Read one window of a declared package resource, from `offset` (>= 0) and
 *  never longer than `maxBytes`. The path must be declared, must still open
 *  inside the package root bound at load, and must still be a regular file: a
 *  package is untrusted content that can change between discovery and read, so
 *  the size that bounds the read is the size of the opened file, never the size
 *  recorded at discovery. That size is also what `totalBytes` reports, so the
 *  window is refused rather than served when the file changed under the read:
 *  a caller pages by byte offset, and a total taken from one generation beside
 *  bytes taken from another names an offset neither file has. Refuses an
 *  offset that is not on a character boundary and bytes that are not UTF-8.
 *
 *  With `has`, a bundled resource is the text that its `{{if:}}` blocks render
 *  for that reader, as a bundled body is (ARCH-CONTEXT-033): offsets and sizes
 *  count the rendered bytes, and a resource that renders to nothing is refused
 *  as undeclared, because `offeredSkillResources` does not offer it. */
export function readSkillResource(
  skill: SkillDefinition,
  path: string,
  offset: number,
  maxBytes: number,
  has?: CapabilityCheck,
): SkillResourceWindow {
  if (!skill.resources.some((resource) => resource.path === path)) {
    throw new Error(`Skill "${skill.id}" does not declare resource "${path}"`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Skill "${skill.id}" resource "${path}": offset must be a whole number of bytes, 0 or greater`);
  }
  const bytes = resourceBytes(skill, path, has);
  if (bytes === undefined) throw new Error(`Skill "${skill.id}" does not declare resource "${path}"`);
  return decodeWindow(subjectOf(skill, path), bytes.subarray(offset, offset + maxBytes), offset, bytes.byteLength);
}

/** The resources of `skill` that the reader `has` describes is offered, each with the bytes it reads: for a bundled
 *  package, every declared file whose `{{if:}}` blocks leave text for that reader, sized as rendered; for any other
 *  package, or without `has`, every declared file as installed. */
export function offeredSkillResources(skill: SkillDefinition, has?: CapabilityCheck): readonly SkillResource[] {
  if (has === undefined || skill.source.authority !== "bundled") return skill.resources;
  return skill.resources.flatMap((resource) => {
    const bytes = resourceBytes(skill, resource.path, has);
    return bytes === undefined ? [] : [{ ...resource, bytes: bytes.byteLength }];
  });
}

/** The whole bytes of one declared resource as the reader `has` reads them, or undefined when a bundled resource
 *  renders to nothing for that reader. */
function resourceBytes(skill: SkillDefinition, path: string, has: CapabilityCheck | undefined): Buffer | undefined {
  const subject = subjectOf(skill, path);
  const raw = installedResourceBytes(skill, path, subject);
  if (has === undefined || skill.source.authority !== "bundled") return raw;
  const rendered = renderCapabilityText(decodeUtf8(subject, raw), has);
  return rendered.length === 0 && raw.byteLength > 0 ? undefined : Buffer.from(rendered, "utf8");
}

function installedResourceBytes(skill: SkillDefinition, path: string, subject: string): Buffer {
  if (skill.source.kind === "manifest") {
    const content = skill.source.files.get(path);
    if (content === undefined) throw new Error(`Bundled skill "${skill.id}" is missing resource "${path}"`);
    return Buffer.from(content, "utf8");
  }
  const bytes = withBoundPackage(skill.source, subject, (root) => readContainedFile(root, path, SKILL_LIMITS.packageBytes));
  if (bytes === undefined) throw new Error(`${subject} cannot be opened in its package (ENOENT)`);
  return bytes;
}

/** One filesystem package as a single generation: the `SKILL.md` body and the
 *  resource manifest, both taken through one identity-checked descriptor of
 *  the directory the load bound, and both proved to have come from the same
 *  install before either is published. A package directory replaced while it
 *  is read fails the load, and so does an in-place edit of the body or of any
 *  declared resource during it: nothing here may advertise one install's
 *  procedure beside another install's file list. The body file is measured
 *  before it is read against the `authority`'s `SKILL.md` cap: a package over
 *  an admission limit costs one `fstat`, never an allocation of its size, and
 *  nothing is decoded or parsed beyond the limit.
 *
 *  Returns undefined when the directory holds no `SKILL.md` and so is not a
 *  package at all; every other read failure throws. `entriesOf` is the
 *  directory stream the resource walk reads, which a caller substitutes to
 *  drive the walk against entries it controls. */
export function readSkillPackage(
  binding: SkillPackageBinding,
  authority: SkillAuthority,
  entriesOf?: SkillDirectoryEntries,
): SkillPackage | undefined {
  const skillFileCap = skillFileByteCap(authority);
  return withAdmittedPackage(binding, { entriesOf, skillFileCap }, (root, admitted) => ({
    skillFile: admitted.skillFile,
    resources: admitted.resources,
    identity: { sha256: identifyPackage(root, admitted, skillFileCap), bytes: admitted.bytes },
  }));
}

/** Read every declared file of one package generation from the same
 *  contained bytes, keyed by package-relative path. */
export function readSkillPackageFiles(
  binding: SkillPackageBinding,
  authority: SkillAuthority,
  entriesOf?: SkillDirectoryEntries,
): ReadonlyMap<string, string> | undefined {
  const skillFileCap = skillFileByteCap(authority);
  return withAdmittedPackage(binding, { entriesOf, skillFileCap }, (root, admitted) => {
    if (readResolvedStepFile(root, skillFileCap) !== admitted.skillFile) throw generationChanged(SKILL_FILE);
    const files = new Map<string, string>([[SKILL_FILE, admitted.skillFile]]);
    visitDeclaredFiles(root, admitted, (path, bytes) => {
      const text = decodeUtf8(path, bytes);
      if (Buffer.byteLength(text, "utf8") !== bytes.byteLength) {
        throw new Error(`${path} is not text that encodes back to its bytes on disk, so the package cannot be rewritten whole`);
      }
      files.set(path, text);
    });
    return files;
  });
}

/** What one package directory holds, admitted but not yet read: the `SKILL.md`
 *  text, the declared resources with the size each was measured at, the whole
 *  package total, and the generation of every declared file. */
interface AdmittedPackage {
  readonly skillFile: string;
  readonly resources: readonly SkillResource[];
  readonly bytes: number;
  readonly generations: ReadonlyMap<string, Buffer>;
}

function withBoundPackage<T>(
  binding: SkillPackageBinding,
  subject: string,
  use: (root: ContainedDirectoryContract) => T,
): T | undefined {
  let parent: ContainedDirectoryContract;
  try {
    parent = ContainedDirectory.open(dirname(binding.canonicalDir), []);
  } catch (error) {
    throw containmentFailure(subject, error);
  }
  let root: ContainedDirectoryContract | undefined;
  try {
    root = parent.openExistingChild(basename(binding.canonicalDir));
  } catch (error) {
    throw containmentFailure(subject, error);
  } finally {
    parent.close();
  }
  if (root === undefined) return undefined;
  try {
    root.requireSamePathAs(binding.canonicalDir);
    if (root.identity() !== binding.canonicalId) {
      throw new Error(`${subject} escapes its package: the package directory is no longer the one it was loaded from`);
    }
    const result = use(root);
    root.requireSamePathAs(binding.canonicalDir);
    return result;
  } catch (error) {
    try {
      root.requireSamePathAs(binding.canonicalDir);
    } catch (cause) {
      throw new Error(`${subject} escapes its package: the package directory is no longer the one it was loaded from`, { cause });
    }
    if (error instanceof ContainedPathError) throw containmentFailure(subject, error);
    throw error;
  } finally {
    root.close();
  }
}

function readContainedFile(root: ContainedDirectoryContract, path: string, maxBytes: number): Buffer | undefined {
  const components = path.split("/");
  const file = components.pop();
  if (file === undefined) return undefined;
  const children: ContainedDirectoryContract[] = [];
  let current: ContainedDirectoryContract = root;
  try {
    for (const component of components) {
      assertSafePathComponent(component);
      const child = current.openExistingChild(component);
      if (child === undefined) return undefined;
      children.push(child);
      current = child;
    }
    assertSafePathComponent(file);
    return current.readFile(file, maxBytes);
  } finally {
    for (const child of children.toReversed()) child.close();
  }
}

function readContainedOwnedFile(root: ContainedDirectoryContract, path: string, maxBytes: number): ContainedOwnedFile | undefined {
  const components = path.split("/");
  const file = components.pop();
  if (file === undefined) return undefined;
  const children: ContainedDirectoryContract[] = [];
  let current: ContainedDirectoryContract = root;
  try {
    for (const component of components) {
      assertSafePathComponent(component);
      const child = current.openExistingChild(component);
      if (child === undefined) return undefined;
      children.push(child);
      current = child;
    }
    assertSafePathComponent(file);
    return current.readOwnedFile(file, maxBytes);
  } finally {
    for (const child of children.toReversed()) child.close();
  }
}

function withAdmittedPackage<T>(
  binding: SkillPackageBinding,
  admission: { readonly entriesOf?: SkillDirectoryEntries; readonly skillFileCap: number | undefined },
  use: (root: ContainedDirectoryContract, admitted: AdmittedPackage) => T,
): T | undefined {
  return withBoundPackage(binding, SKILL_FILE, (root) => {
    const skillFile = readResolvedStepFile(root, admission.skillFileCap);
    if (skillFile === undefined) return undefined;
    const walk: ResourceWalk = { entriesOf: admission.entriesOf ?? containedEntries, resources: [], generations: new Map(), examined: 0 };
    collectResources(walk, root, "", 0);
    const resources = sealResources(walk.resources);
    const bytes = admitPackageBytes(skillFile, resources);
    return use(root, { skillFile, resources, bytes, generations: walk.generations });
  });
}

/** Whether the bound directory installs a `SKILL.md` file. */
export function holdsSkillFile(binding: SkillPackageBinding): boolean {
  try {
    return withBoundPackage(binding, SKILL_FILE, (root) => readContainedFile(root, SKILL_FILE, SKILL_LIMITS.packageBytes) !== undefined) ?? false;
  } catch (error) {
    if (isAbsentPath(error)) return false;
    throw error;
  }
}

function identifyPackage(root: ContainedDirectoryContract, admitted: AdmittedPackage, skillFileCap: number | undefined): string {
  if (readResolvedStepFile(root, skillFileCap) !== admitted.skillFile) throw generationChanged(SKILL_FILE);
  const digest = openPackageDigest(admitted.skillFile);
  visitDeclaredFiles(root, admitted, (path, bytes) => {
    foldFileHeader(digest, path, bytes.byteLength);
    foldFileContent(digest, bytes);
  });
  return digest.digest("hex");
}

function visitDeclaredFiles(
  root: ContainedDirectoryContract,
  admitted: AdmittedPackage,
  read: (path: string, bytes: Buffer) => void,
): void {
  for (const { path } of admitted.resources) {
    const owned = readContainedOwnedFile(root, path, SKILL_LIMITS.packageBytes);
    const expected = admitted.generations.get(path);
    if (owned === undefined || expected === undefined || !owned.content.equals(expected)) throw generationChanged(path);
    read(path, owned.content);
    const after = readContainedFile(root, path, SKILL_LIMITS.packageBytes);
    if (after === undefined || !after.equals(expected)) throw generationChanged(path);
  }
}

function foldFileContent(digest: Hash, bytes: Buffer): void {
  for (let position = 0; position < bytes.byteLength; position += DIGEST_WINDOW_BYTES) {
    digest.update(bytes.subarray(position, position + DIGEST_WINDOW_BYTES));
  }
}

function generationChanged(subject: string): Error {
  return new Error(`${subject} changed while the package was read; the package is refused rather than served as a mix of two installs`);
}

function readResolvedStepFile(root: ContainedDirectoryContract, maxBytes: number | undefined): string | undefined {
  try {
    const bytes = readContainedFile(root, SKILL_FILE, maxBytes ?? SKILL_LIMITS.packageBytes);
    return bytes === undefined ? undefined : decodeUtf8(SKILL_FILE, bytes);
  } catch (error) {
    if (maxBytes !== undefined && error instanceof Error && error.message.includes("read limit")) {
      throw new Error(`${SKILL_FILE} is over the ${maxBytes}-byte limit; a package is admitted whole, so move the detail into resource files`, { cause: error });
    }
    throw error;
  }
}

function containmentFailure(subject: string, err: unknown): Error {
  const code = errorCode(err);
  if (err instanceof ContainedPathError || code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
    return Object.assign(new Error(`${subject} escapes its package: a symlink or non-directory replaced part of its path`, { cause: err }), { code });
  }
  return Object.assign(new Error(`${subject} cannot be opened in its package (${String(code ?? "unknown error")})`, { cause: err }), { code });
}

function subjectOf(skill: SkillDefinition, path: string): string {
  return `Skill "${skill.id}" resource "${path}"`;
}

/** Decode one window of resource bytes, or refuse it. The caller pages by byte
 *  offset, so a window that starts inside a character, or a lossy decode, would
 *  shift every following window; `endOffset` is measured on the source bytes
 *  for the same reason. */
function decodeWindow(
  subject: string,
  window: Buffer,
  offset: number,
  totalBytes: number,
): SkillResourceWindow {
  if (offset > totalBytes) {
    throw new Error(`${subject}: offset ${offset} is past its ${totalBytes} bytes`);
  }
  const first = window[0] ?? 0;
  if (first >= 0x80 && first < 0xc0) {
    throw new Error(`${subject}: offset ${offset} is inside a character; read from the offset the previous window reported`);
  }

  const bytes = trimPartialUtf8(window);
  if (bytes.length < window.length && offset + window.length >= totalBytes) {
    throw new Error(`${subject} is not valid UTF-8 text: it ends inside a character`);
  }
  if (bytes.length === 0 && offset < totalBytes) {
    throw new Error(`${subject}: the read window is too small to hold the character at offset ${offset}`);
  }
  return { content: decodeUtf8(subject, bytes), endOffset: offset + bytes.length, totalBytes };
}

function decodeUtf8(subject: string, bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch (err) {
    throw new Error(`${subject} is not valid UTF-8 text`, { cause: err });
  }
}

/** Drop a trailing partial UTF-8 sequence so a window decodes byte-for-byte and
 *  the next window starts on a character boundary. */
function trimPartialUtf8(window: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= window.length; back++) {
    const byte = window[window.length - back] ?? 0;
    if (byte < 0x80) break;
    if (byte < 0xc0) continue;
    const needed = byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    return needed > back ? window.subarray(0, window.length - back) : window;
  }
  return window;
}

interface ResourceWalk {
  readonly entriesOf: SkillDirectoryEntries;
  readonly resources: SkillResource[];
  readonly generations: Map<string, Buffer>;
  examined: number;
}

function collectResources(walk: ResourceWalk, directory: ContainedDirectoryContract, prefix: string, depth: number): void {
  if (depth > MAX_RESOURCE_DEPTH) return;
  for (const entry of walk.entriesOf(directory)) {
    if (walk.resources.length > SKILL_LIMITS.resources) return;
    walk.examined++;
    if (walk.examined > SKILL_LIMITS.scanEntries) {
      throw new Error(`package directory holds more than ${SKILL_LIMITS.scanEntries} entries; remove files from the package directory`);
    }
    assertSafePathComponent(entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) continue;
    if (entry.type === "directory") {
      const child = directory.openExistingChild(entry.name);
      if (child === undefined) throw new Error(`${path} disappeared while the package was read`);
      try {
        collectResources(walk, child, path, depth + 1);
      } finally {
        child.close();
      }
      continue;
    }
    if (entry.type !== "file" || path === SKILL_FILE) continue;
    declareContainedFile(walk, directory, entry.name, path);
  }
}

function declareContainedFile(walk: ResourceWalk, directory: ContainedDirectoryContract, name: string, path: string): void {
  let owned: ContainedOwnedFile | undefined;
  try {
    owned = readContainedOwnedFile(directory, name, SKILL_LIMITS.packageBytes);
  } catch (error) {
    if (error instanceof Error && error.message.includes(`exceeds its ${SKILL_LIMITS.packageBytes}-byte read limit`)) {
      throw new Error(`${path} puts the package over the ${SKILL_LIMITS.packageBytes}-byte admission limit`, { cause: error });
    }
    throw error;
  }
  if (owned === undefined) throw new Error(`${path} disappeared while the package was read`);
  walk.resources.push({ path, bytes: owned.content.byteLength });
  walk.generations.set(path, owned.content);
}

/** The path does not exist: ENOENT, or ENOTDIR when a parent component is a
 *  file. Every other errno is a read failure of something that is there. */
export function isAbsentPath(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}
