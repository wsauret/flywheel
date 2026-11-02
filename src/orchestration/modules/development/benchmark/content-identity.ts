import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type CanonicalValue = null | string | boolean | number | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Content identity does not accept non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      const member = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (member === undefined) throw new Error(`Content identity does not accept undefined at ${key}`);
      return [key, canonicalValue(member)];
    }));
  }
  throw new Error(`Content identity does not accept ${typeof value}`);
}

/** Returns the SHA-256 identity of exact bytes. */
export function bytesIdentity(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Returns the SHA-256 identity of a canonical JSON representation. */
export function structuredIdentity(value: unknown): string {
  return bytesIdentity(JSON.stringify(canonicalValue(value)));
}

/** Identifies the ordered task suite by its candidate prompt and loaded content. */
export function benchmarkTaskIdentity(
  tasks: readonly { readonly id: string; readonly prompt: string; readonly contentIdentity: string }[],
): string {
  return structuredIdentity(tasks.map(({ id, prompt, contentIdentity }) => ({ id, prompt, contentIdentity })));
}

/** The Flywheel source this module was loaded from. A dev service loads it from
 *  a source snapshot, which holds these members and not the rest of a checkout. */
const LOADED_SOURCE = resolve(import.meta.dir, "../../../..");
const LOADED_PACKAGE_JSON = resolve(import.meta.dir, "../../../../../package.json");
const LOADED_BUN_LOCK = resolve(import.meta.dir, "../../../../../bun.lock");

/** Identifies the Flywheel source that runs benchmark candidates: `src/` and
 *  the dependency manifests that this process loaded, which can be a source
 *  snapshot rather than the benchmarked project, plus each `harnessDirectory`
 *  that a caller outside `src/` runs candidates through.
 *
 *  It names the tree on disk when it is called. A long-lived process can hold
 *  modules older than that tree, and a later dynamic import can load newer
 *  edits, so the identity detects a source change between runs of one campaign;
 *  it does not prove which code ran inside one process. ARCH-DIRECTORIES-018. */
export async function runningSourceIdentity(harnessDirectories: readonly string[] = []): Promise<string> {
  const [src, harness, packageJson, bunLock] = await Promise.all([
    directoryIdentity(LOADED_SOURCE),
    Promise.all(harnessDirectories.map(directoryIdentity)),
    Bun.file(LOADED_PACKAGE_JSON).bytes(),
    Bun.file(LOADED_BUN_LOCK).bytes(),
  ]);
  return structuredIdentity({ src, harness, packageJson: bytesIdentity(packageJson), bunLock: bytesIdentity(bunLock) });
}

/** Refuses to start a candidate of a resumed campaign under any source but the
 *  one the campaign recorded. A caller checks only when a candidate would
 *  start: judging alone runs no candidate and stays allowed. */
export function requireCampaignSource(recorded: string | undefined, running: string): void {
  if (recorded === running) return;
  throw new Error(recorded === undefined
    ? "This campaign predates recorded Flywheel source identity, so its remaining cells cannot be proven to run on the code that ran its earlier cells. Start a new campaign; rescoring stays available."
    : `Flywheel source changed since this campaign started (campaign ${recorded.slice(0, 12)}, running ${running.slice(0, 12)}); its remaining cells would run on different code. Start a new campaign, or resume from a worktree at the recorded source.`);
}

/** Returns one stable identity for a regular-file tree, including empty directories. */
export async function directoryIdentity(directory: string): Promise<string> {
  const content: Array<
    | { kind: "directory"; path: string }
    | { kind: "file"; path: string; identity: string }
  > = [];
  const visit = async (root: string, prefix: string): Promise<void> => {
    const entries = (await readdir(root, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        content.push({ kind: "directory", path: relativePath });
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        content.push({
          kind: "file",
          path: relativePath,
          identity: bytesIdentity(new Uint8Array(await Bun.file(path).arrayBuffer())),
        });
      } else {
        throw new Error(`Content identity does not support filesystem entry: ${path}`);
      }
    }
  };
  await visit(directory, "");
  return structuredIdentity(content);
}
