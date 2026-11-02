import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";
import { fsyncDirectory } from "../../../../infra/atomic-write.js";

/** Symlink-refusing opens for the artifacts a results directory owns.
 *
 *  A results directory is validated before it is used, and its final component
 *  is opened without following a link, so a file swapped for a symlink after
 *  validation fails rather than writing through the link. `O_NOFOLLOW` is a
 *  POSIX flag; where the platform does not have it, `refuseSymlink` below holds
 *  the same property with an explicit check. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Refuse a path that names a link, for platforms with no `O_NOFOLLOW`.
 *
 *  Windows has no such flag, so an open there would follow the link and write
 *  through it. The check is a separate step from the open, which leaves a window
 *  a POSIX flag does not have; it is still the difference between refusing a
 *  swapped path and writing outside the results directory. Where the flag
 *  exists the open enforces this on its own and nothing extra runs. */
async function refuseSymlink(path: string): Promise<void> {
  if (O_NOFOLLOW !== 0) return;
  const stats = await lstat(path).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw cause;
  });
  if (stats?.isSymbolicLink()) {
    throw Object.assign(new Error(`ELOOP: ${path} names a link, not the owned file`), { code: "ELOOP" });
  }
}

/** What an unparsable JSON line at the very end of a file means.
 *
 *  A log the harness appends to while it runs can be left with a torn tail by
 *  a crash, and that tail is repairable: every record before it is complete.
 *  A log whose completeness is itself an accounting authority rejects the same
 *  tail, because dropping it would silently lower a count. */
export type TornTailPolicy = "repair" | "reject";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle | undefined> {
  await refuseSymlink(path);
  return await open(path, flags).catch((cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (isMissing(error)) return undefined;
    throw error;
  });
}

/** Read one owned JSON artifact. Undefined means it is not there. */
export async function readJsonFile(path: string): Promise<string | undefined> {
  const handle = await openNoFollow(path, constants.O_RDONLY | O_NOFOLLOW);
  if (!handle) return undefined;
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Create one owned JSON artifact. A file already at `path` is an error rather
 *  than something to overwrite, so two runs never share a results directory. */
export async function createJsonFile(path: string, text: string): Promise<void> {
  await refuseSymlink(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  fsyncDirectory(dirname(path));
}

/** Write one owned artifact of a results directory, replacing what is there. */
export async function writeArtifactFile(path: string, text: string): Promise<void> {
  await refuseSymlink(path);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateTo(path: string, text: string): Promise<void> {
  await refuseSymlink(path);
  const handle = await open(path, constants.O_RDWR | O_NOFOLLOW);
  try {
    await handle.truncate(new TextEncoder().encode(text).byteLength);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read a JSON-lines log. A missing file is an empty log. Every present line is
 *  decoded by `parse`, whose failure is corruption and throws with the line's
 *  location; only a torn final line is negotiable, per `tornTail`. */
async function readJsonLines<T>(path: string, parse: (value: unknown) => T, tornTail: TornTailPolicy): Promise<T[]> {
  const text = await readJsonFile(path);
  if (text === undefined) return [];
  const lines = text.split("\n");
  const records: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const isIncompleteTail = index === lines.length - 1 && !text.endsWith("\n");
      if (tornTail === "reject" || !isIncompleteTail) {
        throw new Error(`${path}:${index + 1} is not valid JSON: ${errorMessage(error)}`, { cause });
      }
      await truncateTo(path, text.slice(0, text.lastIndexOf("\n") + 1));
      continue;
    }
    try {
      records.push(parse(value));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      throw new Error(`${path}:${index + 1} does not match its schema: ${errorMessage(error)}`, { cause });
    }
  }
  return records;
}

/** Append one record durably. */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  // Read and append share one handle: the tail this checks must be the tail it
  // writes onto, and O_APPEND keeps concurrent appends whole.
  let handle = await openNoFollow(path, constants.O_RDWR | constants.O_APPEND | O_NOFOLLOW);
  const needsDirectorySync = handle === undefined;
  if (!handle) {
    await refuseSymlink(path);
    try {
      handle = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
      handle = await openNoFollow(path, constants.O_RDWR | constants.O_APPEND | O_NOFOLLOW);
      if (!handle) throw new Error(`Ledger disappeared while opening ${path}`, { cause: error });
    }
  }
  try {
    // A torn write can leave a complete JSON line without its trailing newline;
    // guard so the next append never concatenates two records onto one line.
    const { size } = await handle.stat();
    const tail = new Uint8Array(1);
    if (size > 0) await handle.read(tail, 0, 1, size - 1);
    const needsNewline = size > 0 && tail[0] !== 0x0a;
    await handle.writeFile(`${needsNewline ? "\n" : ""}${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (needsDirectorySync) fsyncDirectory(dirname(path));
}

export interface JsonLinesLedger<T> {
  load(): Promise<T[]>;
  append(value: T): Promise<void>;
}

/** Owns strict decoding, tail policy, and durable writes for one typed ledger. */
export function createJsonLinesLedger<T>(
  path: () => Promise<string>,
  schema: Schema.Decoder<T>,
  tornTail: TornTailPolicy,
): JsonLinesLedger<T> {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
  return {
    async load() {
      return readJsonLines(await path(), decode, tornTail);
    },
    async append(value) {
      const decoded = decode(value);
      await appendJsonLine(await path(), decoded);
    },
  };
}
