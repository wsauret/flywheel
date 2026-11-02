import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";

export type RepositoryRef =
  | { readonly kind: "direct"; readonly object: string }
  | { readonly kind: "symbolic"; readonly target: string; readonly object: string | null };

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Lists every files-backend ref, including unresolved symbolic refs. Throws on incomplete output or unreadable metadata. */
export async function readRepositoryRefs(input: {
  readonly gitDir: string;
  readonly commonDir?: string;
  readonly runGit: OwnedCommandRunner;
}): Promise<ReadonlyMap<string, RepositoryRef>> {
  const listed = await input.runGit(["git", "--no-optional-locks", `--git-dir=${input.gitDir}`, "-c", "core.fsmonitor=false", "for-each-ref", "--format=%(objectname) %(refname) %(symref)"], { timeoutMs: 30_000, maxOutputBytes: MAX_BYTES });
  if (listed.exitCode !== 0 || listed.timedOut || listed.stdoutTruncated) throw new Error("Git could not enumerate complete refs");
  const refs = new Map<string, RepositoryRef>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [object, name, target, ...extra] = line.trimEnd().split(" ");
    if (!object || !OBJECT.test(object) || !name?.startsWith("refs/") || extra.length || refs.has(name)) throw new Error("Git returned an invalid ref enumeration");
    refs.set(name, target ? { kind: "symbolic", target, object } : { kind: "direct", object });
  }
  const mergeLoose = async (directory: string): Promise<void> => {
    let entries = 0;
    let bytes = 0;
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 256 || ++entries > MAX_ENTRIES) throw new Error("Git ref metadata exceeds the inspection bound");
      const path = join(directory, relative);
      const stats = await lstat(path).catch(error => {
        if (error.code === "ENOENT" && relative === "refs") return undefined;
        throw error;
      });
      if (!stats) return;
      if (stats.isDirectory()) {
        for (const name of (await readdir(path)).sort()) await walk(`${relative}/${name}`, depth + 1);
      } else if (stats.isFile()) {
        bytes += stats.size;
        if (bytes > MAX_BYTES) throw new Error("Git ref metadata exceeds the inspection bound");
        const text = (await readMetadataFile(path)).toString("utf8").trim();
        if (text.startsWith("ref: ")) {
          const target = text.slice(5);
          if (!/^refs\/\S+$/.test(target) || target.includes("\0")) throw new Error("Git returned an invalid symbolic ref");
          refs.set(relative, { kind: "symbolic", target, object: null });
        } else {
          if (!OBJECT.test(text)) throw new Error("Git returned an invalid loose ref");
          refs.set(relative, { kind: "direct", object: text });
        }
      } else throw new Error("Git ref metadata is not a regular file or directory");
    };
    await walk("refs", 0);
  };
  await mergeLoose(input.commonDir ?? input.gitDir);
  if (input.commonDir && input.commonDir !== input.gitDir) await mergeLoose(input.gitDir);
  if (refs.size > MAX_ENTRIES) throw new Error("Git refs exceed the inspection bound");
  const resolved = new Map<string, string | null>([...refs].flatMap(([name, ref]) => ref.kind === "direct" ? [[name, ref.object] as const] : []));
  for (const [name, ref] of refs) {
    if (ref.kind !== "symbolic") continue;
    const visited = new Set<string>();
    let current = name;
    while (!resolved.has(current) && !visited.has(current)) {
      visited.add(current);
      const value = refs.get(current);
      if (value?.kind !== "symbolic") break;
      current = value.target;
    }
    const object = resolved.get(current) ?? null;
    for (const entry of visited) resolved.set(entry, object);
    refs.set(name, { ...ref, object });
  }
  return new Map([...refs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** Reads the complete active reftable stack without object access or writes. Missing tables, unsafe paths, and a changing list refuse inspection. */
export async function readReftableStack(gitDir: string): Promise<ReadonlyMap<string, Buffer>> {
  const directory = join(gitDir, "reftable");
  if (!(await lstat(directory)).isDirectory()) throw new Error("Git reftable metadata is not a directory");
  const listPath = join(directory, "tables.list");
  const list = await readMetadataFile(listPath);
  const names = list.toString("utf8").split("\n");
  if (names.pop() !== "" || names.length > MAX_ENTRIES || new Set(names).size !== names.length ||
    names.some(name => !/^[A-Za-z0-9-]+\.ref$/.test(name))) throw new Error("Git returned an invalid reftable list");
  const stack = new Map([["tables.list", list]]);
  let bytes = list.byteLength;
  for (const name of names) {
    const table = await readMetadataFile(join(directory, name));
    bytes += table.byteLength;
    if (bytes > MAX_BYTES) throw new Error("Git reftable exceeds the inspection bound");
    stack.set(name, table);
  }
  if (!list.equals(await readMetadataFile(listPath))) throw new Error("Git reftable list changed during inspection");
  return stack;
}

/** Reads only a regular metadata file; it never follows a symbolic link. */
async function readMetadataFile(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error("Git metadata is not a regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_BYTES) throw new Error("Git metadata is not a bounded regular file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
