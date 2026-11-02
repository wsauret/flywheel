import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalPathWithMissingTail } from "../../infra/canonical-path.js";
import type { OwnedCommandRunner } from "../../infra/owned-command.js";
import { readFullSync } from "../../infra/read-full.js";
import { globalAgentsFile } from "../../infra/paths.js";
import { Log } from "../../infra/log.js";
import { extractMentionPaths } from "./instruction-mentions.js";
import { SYSTEM_PROMPT_SEPARATOR } from "./llm/system-prompt-tiers.js";

/** Checked in order per directory; first match wins. AGENTS.md is the
 *  documented name, so it wins where a case-sensitive file system holds both. */
const CANDIDATES = ["AGENTS.md", "agents.md"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Claude-compatible maximum @-mention chain length below a root instruction file. */
const MAX_MENTION_DEPTH = 5;

const log = Log.create({ service: "project-instructions" });

interface InstructionOmission {
  path: string;
  reason: string;
  error?: string;
}

/**
 * Loads user-global and repository-scoped AGENTS.md instructions.
 *
 * Global rules load first. Rules nearer to the working directory load later
 * and take precedence. Each source keeps its scope and repository-relative
 * path in the rendered prompt. The result is undefined when no file exists.
 *
 * `projectRoot` is the project boundary: the walk starts at `executionCwd` and
 * stops there, and an `executionCwd` outside the boundary reads the boundary
 * itself only. It is the startup-selected project root (ARCH-DIRECTORIES-003), never
 * rediscovered here.
 *
 * A discovered file that cannot be read safely never fails the load: it
 * renders as a labelled section that states it is unavailable, and the load
 * reports it with the other omissions in one warning (ARCH-CONTEXT-025).
 */
export function loadAgentInstructions(input: {
  executionCwd: string;
  projectRoot: string;
  /** Startup-selected account home. The account-global AGENTS.md derives from
   *  it; nothing here looks the account up. */
  accountHome: string;
  /** Startup-selected Flywheel data root. Instruction symlinks and imports
   *  cannot resolve into this credential and account-state boundary. */
  userDataRoot: string;
  /** Asks git whether a missing import is ignored, so that its omission is
   *  not reported. Without it, every missing import is reported. */
  runCommand?: OwnedCommandRunner;
}): string | undefined {
  const projectRoot = resolve(input.projectRoot);
  const accountHome = resolve(input.accountHome);
  const boundaries: InstructionBoundaries = {
    projectRoots: uniquePaths(projectRoot, canonicalPathWithMissingTail(projectRoot)),
    homeRoots: uniquePaths(accountHome, canonicalPathWithMissingTail(accountHome)),
    protectedRoots: uniquePaths(
      canonicalPathWithMissingTail(input.userDataRoot),
      canonicalPathWithMissingTail(join(projectRoot, ".flywheel")),
    ),
  };
  const omissions: InstructionOmission[] = [];
  const projectFiles = walkForInstructionFiles(
    startDir(input.executionCwd, projectRoot),
    projectRoot,
    boundaries,
    omissions,
  );
  const globalFile = probeFile(
    globalAgentsFile(accountHome),
    "User-global instructions (~/.agents/AGENTS.md)",
    "global",
    boundaries,
    omissions,
  );
  const files = globalFile && !projectFiles.some((file) => file.path === globalFile.path)
    ? [globalFile, ...projectFiles]
    : projectFiles;
  if (files.length === 0) {
    reportOmissions(omissions, input.runCommand);
    return undefined;
  }

  const seen = new Set(files.map((file) => file.path));
  const sections: InstructionSection[] = [];
  for (const file of files) {
    sections.push(file, ...("unreadable" in file ? [] : expandMentions(file, { boundaries, seen, omissions, depth: 1 })));
  }

  reportOmissions(omissions, input.runCommand);
  return sections.map(renderInstructionSection).join(SYSTEM_PROMPT_SEPARATOR);
}

/** Where the upward walk begins. A working directory outside the project owns
 *  no project instructions, and walking up from it would read the enclosing
 *  repository's AGENTS.md, so the walk starts at the boundary instead. */
function startDir(executionCwd: string, projectRoot: string): string {
  const resolvedCwd = resolve(executionCwd);
  const fromRoot = relative(projectRoot, resolvedCwd);
  const inside = fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  return inside ? resolvedCwd : projectRoot;
}

type InstructionScope = "global" | "project";

interface InstructionBoundaries {
  projectRoots: readonly string[];
  homeRoots: readonly string[];
  protectedRoots: readonly string[];
}

interface InstructionFile {
  /** Canonical physical path. Nested imports resolve from this file's real directory. */
  path: string;
  logicalPath: string;
  content: string;
  label: string;
  scope: InstructionScope;
  allowedRoots: readonly string[];
}

/** A discovered file whose bytes cannot enter context. Its section keeps the
 *  label, so the model knows which instructions it lacks. */
interface UnreadableInstruction {
  /** Canonical target when one was authorized, else the resolved logical path. */
  path: string;
  label: string;
  unreadable: string;
}

type InstructionSection = InstructionFile | UnreadableInstruction;

function walkForInstructionFiles(
  startDirectory: string,
  projectRoot: string,
  boundaries: InstructionBoundaries,
  omissions: InstructionOmission[],
): InstructionSection[] {
  const seen = new Set<string>();
  const ancestors: InstructionSection[] = [];

  let current = resolve(startDirectory);
  while (true) {
    const file = probeDir(current, projectRoot, boundaries, omissions);
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      ancestors.unshift(file);
    }

    if (current === projectRoot) break;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return ancestors;
}

function probeDir(
  dir: string,
  projectRoot: string,
  boundaries: InstructionBoundaries,
  omissions: InstructionOmission[],
): InstructionSection | null {
  for (const [index, name] of CANDIDATES.entries()) {
    const path = join(dir, name);
    const projectPath = relative(projectRoot, path).replaceAll("\\", "/");
    const file = probeFile(path, `Repository instructions (${projectPath})`, "project", boundaries, omissions);
    if (!file) continue;
    for (const shadowed of CANDIDATES.slice(index + 1)) {
      if (distinctEntries(path, join(dir, shadowed))) recordOmission(omissions, join(dir, shadowed), `shadowed-by-${name}`);
    }
    return file;
  }
  return null;
}

/** Whether two spellings resolve to two files. A case-insensitive file system
 *  resolves both spellings to one file, and so does a link between them. */
function distinctEntries(left: string, right: string): boolean {
  try {
    return !sameIdentity(statSync(left, { bigint: true }), statSync(right, { bigint: true }));
  } catch {
    return false;
  }
}

function probeFile(
  logicalPath: string,
  label: string,
  scope: InstructionScope,
  boundaries: InstructionBoundaries,
  omissions: InstructionOmission[],
): InstructionSection | null {
  const resolvedLogicalPath = resolve(logicalPath);
  // The section's identity: the canonical target once it is authorized, so
  // two links to one unreadable file render one section.
  let identity = resolvedLogicalPath;
  try {
    const target = resolveInstructionTarget(resolvedLogicalPath);
    if (target.kind === "missing") return null;
    if (target.kind === "broken-link") {
      recordOmission(omissions, resolvedLogicalPath, target.kind);
      return null;
    }
    if (target.kind !== "file") throw new Error(`${basename(resolvedLogicalPath)} must resolve to a regular file`);
    const rejection = rejectedTargetReason(target.path, scope, boundaries);
    if (rejection !== undefined) {
      recordOmission(omissions, resolvedLogicalPath, rejection);
      return null;
    }
    identity = target.path;
    const content = readInstructionFile(target.path, target.identity);
    if (content === null) {
      recordOmission(omissions, resolvedLogicalPath, "unavailable-during-read");
      return { path: identity, label, unreadable: `${basename(resolvedLogicalPath)} was removed while it was being read` };
    }
    return {
      path: target.path,
      logicalPath: resolvedLogicalPath,
      content,
      label,
      scope,
      allowedRoots: allowedRoots(scope, boundaries, target.path),
    };
  } catch (error) {
    recordOmission(omissions, resolvedLogicalPath, "unreadable", error);
    return { path: identity, label, unreadable: error instanceof Error ? error.message : String(error) };
  }
}

interface MentionContext {
  boundaries: InstructionBoundaries;
  /** Canonical paths already included anywhere in the load; breaks cycles and duplicates. */
  seen: Set<string>;
  omissions: InstructionOmission[];
  depth: number;
}

/** Expands the parent's @-mentions depth-first, each mentioned file becoming
 *  its own section. Explicit unresolved imports are logged and never fatal. */
function expandMentions(parent: InstructionFile, context: MentionContext): InstructionFile[] {
  const projectRoot = parent.scope === "project" ? context.boundaries.projectRoots[0] : undefined;
  const mentions = extractMentionPaths(parent.content, parent.path, context.boundaries.homeRoots[0] ?? dirname(parent.path), projectRoot);
  if (context.depth >= MAX_MENTION_DEPTH) {
    for (const alternatives of mentions) {
      const mention = alternatives[0];
      if (mention !== undefined && namesImport(mention)) recordOmission(context.omissions, mention, "depth-limit");
    }
    return [];
  }

  const sections: InstructionFile[] = [];
  for (const alternatives of mentions) {
    // The verbatim path wins when it exists; the trailing-period-stripped
    // fallback only rescues a mention that captured sentence punctuation.
    const mention = alternatives.find(entryExists);
    if (mention === undefined) {
      const missing = alternatives[0];
      if (missing !== undefined && namesImport(missing)) recordOmission(context.omissions, missing, "missing-target");
      continue;
    }
    const file = readMentionedFile(mention, parent, context);
    if (!file) continue;
    sections.push(file, ...expandMentions(file, { ...context, depth: context.depth + 1 }));
  }
  return sections;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readMentionedFile(path: string, parent: InstructionFile, context: MentionContext): InstructionFile | null {
  const logicalPath = resolve(path);
  if (!parent.allowedRoots.some((root) => within(logicalPath, root))) {
    recordOmission(context.omissions, logicalPath, "outside-authorized-roots");
    return null;
  }
  if (isCredentialPath(logicalPath)) {
    recordOmission(context.omissions, logicalPath, "credential-file");
    return null;
  }
  const scope = context.boundaries.projectRoots.some((root) => within(logicalPath, root))
    ? "project"
    : parent.scope;

  try {
    const target = resolveInstructionTarget(logicalPath);
    if (target.kind !== "file") {
      recordOmission(context.omissions, logicalPath, target.kind);
      return null;
    }
    const rejection = rejectedTargetReason(target.path, scope, context.boundaries);
    if (rejection !== undefined) {
      recordOmission(context.omissions, logicalPath, rejection);
      return null;
    }
    if (context.seen.has(target.path)) return null;
    context.seen.add(target.path);

    const content = readInstructionFile(target.path, target.identity);
    if (content === null) {
      recordOmission(context.omissions, logicalPath, "unavailable-during-read");
      return null;
    }
    if (content.trim().length === 0) {
      recordOmission(context.omissions, logicalPath, "empty-file");
      return null;
    }
    const inheritedRoots = scope === parent.scope
      ? parent.allowedRoots
      : rootsForScope(scope, context.boundaries);
    return {
      path: target.path,
      logicalPath,
      content,
      label: `Imported instructions (${displayPath(logicalPath, parent.path, context.boundaries)})`,
      scope,
      allowedRoots: uniquePaths(...inheritedRoots, dirname(target.path)),
    };
  } catch (error) {
    recordOmission(context.omissions, logicalPath, "unreadable", error);
    return null;
  }
}

type InstructionTarget =
  | { kind: "file"; path: string; identity: BigIntStats }
  | { kind: "missing" | "broken-link" | "not-regular-file" };

function resolveInstructionTarget(path: string): InstructionTarget {
  let entry: BigIntStats;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    throw instructionReadError(path, error);
  }
  try {
    const target = statSync(path, { bigint: true });
    if (!target.isFile()) return { kind: "not-regular-file" };
    const canonicalPath = canonicalPathWithMissingTail(path);
    const canonicalTarget = lstatSync(canonicalPath, { bigint: true });
    if (!canonicalTarget.isFile() || !sameIdentity(target, canonicalTarget)) {
      throw new Error(`${basename(path)} changed while its canonical identity was resolved`);
    }
    return { kind: "file", path: canonicalPath, identity: canonicalTarget };
  } catch (error) {
    if (entry.isSymbolicLink() && errorCode(error) === "ENOENT") return { kind: "broken-link" };
    throw instructionReadError(path, error);
  }
}

function recordOmission(omissions: InstructionOmission[], path: string, reason: string, error?: unknown): void {
  omissions.push({
    path,
    reason,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  });
}

/** Bare package scopes and handles share @ syntax. A filename-like final
 *  component is the minimum evidence that an unresolved token was an import. */
function namesImport(mention: string): boolean {
  return basename(mention).includes(".");
}

/** Writes one warning that lists every instruction input the load left out.
 *
 *  A missing import whose path git ignores is left out of the warning: the
 *  file is local-only by design, such as a maintainer's private notes. A
 *  missing import of any other path is listed. Git answers for each missing
 *  import, after the load returns, so the load never waits for a process;
 *  when no runner is given or git cannot answer, the import is listed. */
function reportOmissions(omissions: readonly InstructionOmission[], runCommand: OwnedCommandRunner | undefined): void {
  if (runCommand === undefined || !omissions.some((omission) => omission.reason === "missing-target")) {
    warnOmitted(omissions);
    return;
  }
  void Promise.all(omissions.map((omission) => omission.reason === "missing-target" && gitIgnores(omission.path, runCommand)))
    .then((ignored) => warnOmitted(omissions.filter((_, index) => !ignored[index])));
}

function warnOmitted(omissions: readonly InstructionOmission[]): void {
  if (omissions.length > 0) log.warn("AGENTS.md inputs omitted", { omissions });
}

/** Whether git ignores `path`, asked from its nearest existing directory so
 *  that git finds the checkout that holds it. */
async function gitIgnores(path: string, runCommand: OwnedCommandRunner): Promise<boolean> {
  let cwd = dirname(path);
  while (!entryExists(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  try {
    // Exit 0 means ignored; 1 means not ignored; 128 means git could not decide.
    return (await runCommand(["git", "check-ignore", "-q", "--", path], { cwd })).exitCode === 0;
  } catch {
    // boundary: a machine without git cannot launch it; the import stays listed.
    return false;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function uniquePaths(...paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function rootsForScope(scope: InstructionScope, boundaries: InstructionBoundaries): readonly string[] {
  return scope === "project"
    ? boundaries.projectRoots
    : uniquePaths(...boundaries.homeRoots, ...boundaries.projectRoots);
}

function allowedRoots(scope: InstructionScope, boundaries: InstructionBoundaries, target: string): readonly string[] {
  return uniquePaths(...rootsForScope(scope, boundaries), dirname(target));
}

function isProtected(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => within(path, root));
}

function rejectedTargetReason(
  path: string,
  scope: InstructionScope,
  boundaries: InstructionBoundaries,
): "account-home" | "credential-file" | "protected-root" | undefined {
  if (isCredentialPath(path)) return "credential-file";
  if (isProtected(path, boundaries.protectedRoots)) return "protected-root";
  if (
    scope === "project"
    && boundaries.homeRoots.some((root) => within(path, root))
    && !boundaries.projectRoots.some((root) => within(path, root))
  ) return "account-home";
  return undefined;
}

function isCredentialPath(path: string): boolean {
  return basename(path) === ".env" || basename(path).startsWith(".env.");
}

function displayPath(path: string, parentPath: string, boundaries: InstructionBoundaries): string {
  for (const root of boundaries.projectRoots) {
    if (within(path, root)) return relative(root, path).replaceAll("\\", "/");
  }
  for (const root of boundaries.homeRoots) {
    if (within(path, root)) return `~/${relative(root, path).replaceAll("\\", "/")}`;
  }
  return relative(dirname(parentPath), path).replaceAll("\\", "/");
}

function readInstructionFile(path: string, expectedIdentity: BigIntStats): string | null {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw instructionReadError(path, error);
  }
  if (!before.isFile() || !sameIdentity(expectedIdentity, before)) {
    throw new Error(`${basename(path)} changed after its canonical identity was authorized`);
  }

  let fd: number;
  try {
    fd = openSync(path, FILE_FLAGS);
  } catch (error) {
    throw instructionReadError(path, error);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(expectedIdentity, opened)) {
      throw new Error(`${basename(path)} changed before it could be opened safely`);
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${basename(path)} is too large to read safely`);
    }

    const buffer = Buffer.alloc(Number(opened.size));
    readFullSync(fd, buffer, 0, basename(path));
    const after = fstatSync(fd, { bigint: true });
    if (!sameSnapshot(opened, after)) throw new Error(`${basename(path)} changed while it was being read`);

    return decodeInstructionBytes(buffer, basename(path));
  } finally {
    closeSync(fd);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function decodeInstructionBytes(buffer: Buffer, subject: string): string {
  try {
    return UTF8.decode(buffer);
  } catch {
    throw new Error(`${subject} must contain valid UTF-8 text`);
  }
}


function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function instructionReadError(path: string, cause: unknown): Error {
  return new Error(`${basename(path)} could not be read safely (${String(errorCode(cause) ?? "unknown error")})`, { cause });
}

function renderInstructionSection(section: InstructionSection): string {
  const body = "unreadable" in section
    ? `[UNREADABLE: ${section.unreadable}. These instructions are unavailable until the file is repaired; tell the person when it matters.]`
    : section.content;
  return `## ${section.label}\n\n${body}`;
}
