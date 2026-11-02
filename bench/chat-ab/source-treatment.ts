import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, copyFile, chmod, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { bytesIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";

export const BenchmarkPatchPath = Schema.String.check(Schema.makeFilter((path) =>
  path.startsWith("bench/") && path.endsWith(".patch") && !path.includes("\\") &&
  !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  || "A patch must name a repository-relative .patch file under bench/ without dot segments"));
export const SourcePatchSchema = Schema.Struct({ path: BenchmarkPatchPath, sha256: Schema.String });
const SourceSchema = Schema.Struct({
  revision: Schema.String,
  tree: Schema.String,
  packageIdentity: Schema.String,
  lockIdentity: Schema.String,
  dependencyIdentity: Schema.String,
  patches: Schema.optionalKey(Schema.Array(SourcePatchSchema)),
});
export type SourceTreatment = typeof SourceSchema.Type;

const PreparedSchema = Schema.Struct({
  version: Schema.Literal(1),
  source: SourceSchema,
  sourceIdentity: Schema.String,
  harnessIdentity: Schema.String,
  installedDependencyIdentity: Schema.String,
  patchedDependencyIdentity: Schema.optionalKey(Schema.String),
});
export type PreparedSourceTreatment = typeof PreparedSchema.Type & { readonly root: string };
const RECORD = ".coding-ab-treatment.json";
const HARNESS = ["bench/chat-ab", "bench/shared", "bench/tasks"] as const;
const EXCLUDED = new Set(["results", ".staged", "node_modules", ".git", ".locks"]);

async function command(run: OwnedCommandRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(args, { cwd, timeoutMs: 600_000, maxOutputBytes: 64_000_000 });
  if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`Source treatment command failed: ${args.join(" ")} (exit ${result.exitCode})\n${result.stderr}`);
  }
  return result.stdout;
}

/** Resolves a commit once. Branch names never become execution identities. */
export async function resolveSourceTreatment(repoRoot: string, revision: string, run: OwnedCommandRunner, patches?: readonly string[]): Promise<SourceTreatment> {
  const commit = (await command(run, repoRoot, ["git", "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).trim();
  const tree = (await command(run, repoRoot, ["git", "rev-parse", `${commit}^{tree}`])).trim();
  const packageIdentity = bytesIdentity(await command(run, repoRoot, ["git", "show", `${commit}:package.json`]));
  const lockIdentity = bytesIdentity(await command(run, repoRoot, ["git", "show", `${commit}:bun.lock`]));
  const files = (await command(run, repoRoot, ["git", "ls-tree", "-r", "--name-only", "-z", commit])).split("\0").filter(Boolean);
  const dependencies = await Promise.all(files.filter(isDependency).sort().map(async (path) => ({
    path, identity: bytesIdentity(await command(run, repoRoot, ["git", "show", `${commit}:${path}`])),
  })));
  const resolvedPatches = patches && await Promise.all(patches.map(async (path) => {
    Schema.decodeUnknownSync(BenchmarkPatchPath)(path);
    const physical = relative(await realpath(join(repoRoot, "bench")), await realpath(join(repoRoot, path)));
    if (isAbsolute(physical) || physical === ".." || physical.startsWith(`..${sep}`)) throw new Error(`Patch escapes benchmark ownership: ${path}`);
    return { path, sha256: bytesIdentity(await readFile(join(repoRoot, path))) };
  }));
  return { revision: commit, tree, packageIdentity, lockIdentity, dependencyIdentity: structuredIdentity(dependencies),
    ...(resolvedPatches ? { patches: resolvedPatches } : {}) };
}

function isDependency(path: string): boolean {
  return !path.startsWith("bench/") && (path === "bun.lock" || path === "package.json" || path.endsWith("/package.json"));
}

interface Entry {
  readonly path: string;
  readonly kind: "file" | "link";
  readonly identity: string;
  readonly executable: boolean;
}

async function entries(root: string, paths: readonly string[], skip: (path: string, name: string) => boolean): Promise<Entry[]> {
  const found: Entry[] = [];
  const visit = async (path: string): Promise<void> => {
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) {
        if (!skip(`${path}/${child}`, child)) await visit(`${path}/${child}`);
      }
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      found.push({
        path, kind: stat.isSymbolicLink() ? "link" : "file",
        identity: bytesIdentity(stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute)),
        executable: (stat.mode & 0o111) !== 0,
      });
    } else {
      throw new Error(`Unsupported treatment filesystem entry: ${absolute}`);
    }
  };
  for (const path of paths) await visit(path);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function harnessEntries(root: string): Promise<Entry[]> {
  const configs = (await readdir(root)).filter((path) => /^tsconfig.*bench.*\.json$/.test(path));
  return entries(root, [...HARNESS, ...configs], (_path, name) => EXCLUDED.has(name));
}

/** Identify the fixed controller harness, excluding results and package runtime state. */
export async function benchmarkHarnessIdentity(root: string): Promise<string> {
  return structuredIdentity(await harnessEntries(root));
}

async function content(root: string, run: OwnedCommandRunner): Promise<{ sourceIdentity: string; dependencyIdentity: string; installedDependencyIdentity: string }> {
  const paths = (await command(run, root, ["git", "ls-files", "-z"])).split("\0").filter(Boolean);
  const dependencies = await entries(root, paths.filter(isDependency), () => false);
  // Walk runtime trees as well as tracked files so an added module cannot escape validation.
  const roots = ["src", "scripts", "crates"].filter((path) => paths.some((file) => file.startsWith(`${path}/`)));
  const sourceFiles = paths.filter((path) =>
    !roots.some((prefix) => path.startsWith(`${prefix}/`)) &&
    !path.startsWith("bench/") && !isDependency(path) &&
    !/^tsconfig.*bench.*\.json$/.test(path));
  const source = await entries(root, [...roots, ...sourceFiles], (_path, name) => name === ".locks" || name === "node_modules" || name === "target");
  const installed = await entries(root, ["node_modules"], (_path, name) => name === ".cache");
  return {
    sourceIdentity: structuredIdentity(source),
    dependencyIdentity: structuredIdentity(dependencies.map(({ path, identity }) => ({ path, identity }))),
    installedDependencyIdentity: structuredIdentity(installed),
  };
}

async function readPrepared(root: string): Promise<PreparedSourceTreatment> {
  const record = Schema.decodeUnknownSync(PreparedSchema)(JSON.parse(await readFile(join(root, RECORD), "utf8")));
  return { ...record, root };
}

async function validateHarnessDestinations(root: string, paths: readonly string[]): Promise<void> {
  const physicalRoot = await realpath(root);
  for (const path of paths) {
    const local = relative(root, resolve(root, path));
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error(`Harness destination escapes treatment: ${path}`);
    }
    let component = root;
    for (const name of ["", ...local.split(sep)]) {
      component = join(component, name);
      let stat;
      try { stat = await lstat(component); } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
        break;
      }
      if (stat.isSymbolicLink()) throw new Error(`Harness destination contains a symlink: ${component}`);
      const physical = relative(physicalRoot, await realpath(component));
      if (isAbsolute(physical) || physical === ".." || physical.startsWith(`..${sep}`)) {
        throw new Error(`Harness destination escapes treatment: ${component}`);
      }
    }
  }
}

/** Refuses changed source, harness, declarations, installed packages, or commit before execution. */
export async function validatePreparedTreatment(prepared: PreparedSourceTreatment, run: OwnedCommandRunner): Promise<void> {
  const stored = await readPrepared(prepared.root);
  const { root: _root, ...expected } = prepared;
  const { root: _storedRoot, ...actual } = stored;
  if (structuredIdentity(actual) !== structuredIdentity(expected)) throw new Error("Prepared treatment record changed");
  const source = await resolveSourceTreatment(prepared.root, "HEAD", run, prepared.source.patches?.map(({ path }) => path));
  if (structuredIdentity(source) !== structuredIdentity(prepared.source)) throw new Error("Prepared treatment revision changed");
  const current = await content(prepared.root, run);
  if (current.dependencyIdentity !== (prepared.patchedDependencyIdentity ?? prepared.source.dependencyIdentity)) throw new Error("Prepared treatment dependency declarations changed");
  if (current.sourceIdentity !== prepared.sourceIdentity) throw new Error("Prepared treatment source changed");
  if (await benchmarkHarnessIdentity(prepared.root) !== prepared.harnessIdentity) throw new Error("Prepared treatment harness changed");
  if (current.installedDependencyIdentity !== prepared.installedDependencyIdentity) throw new Error("Prepared treatment installed dependencies changed");
}

/** Creates a registered detached worktree and frozen install, then replaces only the benchmark harness.
 * Existing directories must carry the same valid preparation record. Failed preparations stay owned by the caller.
 */
export async function prepareSourceTreatment(options: {
  readonly repoRoot: string;
  readonly harnessRoot: string;
  readonly directory: string;
  readonly source: SourceTreatment;
  readonly run: OwnedCommandRunner;
}): Promise<PreparedSourceTreatment> {
  const { repoRoot, harnessRoot, source, run } = options;
  const root = resolve(options.directory);
  const harness = await harnessEntries(harnessRoot);
  const harnessIdentity = structuredIdentity(harness);
  let exists = true;
  try { await lstat(root); } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    const prepared = await readPrepared(root);
    if (structuredIdentity(prepared.source) !== structuredIdentity(source) || prepared.harnessIdentity !== harnessIdentity) {
      throw new Error(`Refusing different source treatment at ${root}`);
    }
    await validatePreparedTreatment(prepared, run);
    return prepared;
  }
  const resolved = await resolveSourceTreatment(repoRoot, source.revision, run, source.patches?.map(({ path }) => path));
  if (structuredIdentity(resolved) !== structuredIdentity(source)) throw new Error("Source treatment identity does not match Git");
  await mkdir(dirname(root), { recursive: true });
  await command(run, repoRoot, ["git", "worktree", "add", "--detach", root, source.revision]);
  for (const patch of source.patches ?? []) {
    await command(run, root, ["git", "apply", "--", join(repoRoot, patch.path)]);
  }
  await command(run, root, ["bun", "install", "--frozen-lockfile"]);
  await mkdir(join(root, "node_modules"), { recursive: true });
  const snapshot = await content(root, run);
  if (!source.patches && snapshot.dependencyIdentity !== source.dependencyIdentity) throw new Error("Frozen installation changed dependency declarations");
  for (const entry of harness) {
    if (entry.kind !== "file") throw new Error(`Harness must contain regular files: ${entry.path}`);
  }
  // Check the complete replacement before deleting anything from the committed worktree.
  await validateHarnessDestinations(root, [...HARNESS, ...harness.map(({ path }) => path), RECORD]);
  for (const path of HARNESS) {
    await rm(join(root, path), { recursive: true, force: true });
    await mkdir(join(root, path), { recursive: true });
  }
  for (const entry of harness) {
    const destination = join(root, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(harnessRoot, entry.path), destination);
    await chmod(destination, entry.executable ? 0o755 : 0o644);
  }
  const prepared: PreparedSourceTreatment = {
    version: 1, root, source, sourceIdentity: snapshot.sourceIdentity,
    harnessIdentity, installedDependencyIdentity: snapshot.installedDependencyIdentity,
    ...(source.patches ? { patchedDependencyIdentity: snapshot.dependencyIdentity } : {}),
  };
  const { root: _root, ...record } = prepared;
  await writeFile(join(root, RECORD), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  await validatePreparedTreatment(prepared, run);
  return prepared;
}
