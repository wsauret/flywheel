/** One JSON file of account secrets, read and mutated under a cross-process lock.
 *
 *  The file lives below the account home, and every component Flywheel owns on
 *  the way down to it (`.flywheel`, `auth`, and the file itself) is resolved
 *  relative to its parent's descriptor and never followed through a symlink. A
 *  link planted at any of them is refused instead of redirecting a credential
 *  read to a file an attacker chose, or a credential write to a file outside the
 *  account. The lock, the read, and the publication of one mutation are all
 *  operations on the one directory the window admitted. */

import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { acquireLockIn, releaseLockIn, type LockHold } from "../ownership-file-lock.js";
import { ContainedDirectory, ContainedPathError } from "../descriptor-directory.js";
import { ensurePrivateRootDirectory } from "../private-path.js";
import { directoryComponents, readFileUnder, type ContainedFileLocation } from "../write-file-under.js";

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
interface JsonObject { readonly [key: string]: JsonValue }

/** A secret store is one small JSON object; anything larger is not one. */
const MAX_STORE_BYTES = 1024 * 1024;

export type LockedJsonState<T> =
  | { readonly tag: "absent"; readonly revision: string }
  | { readonly tag: "valid"; readonly value: T; readonly revision: string }
  | { readonly tag: "malformed"; readonly revision: string };

export interface LockedJsonStoreOptions<T> {
  /** The account-owned base and the Flywheel-owned path below it. */
  readonly location: ContainedFileLocation;
  readonly empty: () => T;
  readonly decode: (value: JsonValue) => T;
  readonly encode: (value: T) => object;
  readonly maxBytes?: number;
}

export class MalformedLockedJsonError extends Schema.TaggedError<MalformedLockedJsonError>()(
  "MalformedLockedJsonError",
  { message: Schema.String, path: Schema.String },
) {}

export class AccountStorageAccessError extends Schema.TaggedError<AccountStorageAccessError>()(
  "AccountStorageAccessError",
  {
    message: Schema.String,
    path: Schema.String,
    category: Schema.Literals(["oversized", "unsafe_path"]),
    code: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

/** The absolute path of the store, for a message or a log line only: no
 *  operation resolves it. */
export function lockedJsonStorePath(location: ContainedFileLocation): string {
  return join(location.baseDir, location.relativePath);
}

function accountStorageAccessError(location: ContainedFileLocation, cause: unknown): AccountStorageAccessError {
  const category = cause instanceof ContainedPathError
    ? "unsafe_path"
    : cause instanceof Error && cause.message.includes("-byte read limit")
      ? "oversized"
      : undefined;
  if (category === undefined) throw cause;
  const path = lockedJsonStorePath(location);
  const explicitCode = cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
  const code = explicitCode ?? (category === "unsafe_path" ? "ELOOP" : undefined);
  return new AccountStorageAccessError({
    message: `Cannot access account storage at ${path} safely: a symlink or non-directory holds part of its path. Repair or move the unsafe path and try again.`,
    path,
    category,
    ...(code === undefined ? {} : { code }),
    cause,
  });
}

function accountStorageOperation<T>(location: ContainedFileLocation, operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    throw accountStorageAccessError(location, cause);
  }
}

export function readLockedJsonStore<T>(options: LockedJsonStoreOptions<T>): LockedJsonState<T> {
  return decodeState(readLockedJsonBytes(options), options);
}

/** The revision `readLockedJsonStore` states, without decoding the bytes.
 *  Throws the same `AccountStorageAccessError` for a file it refuses. */
export function readLockedJsonStoreRevision(options: Pick<LockedJsonStoreOptions<unknown>, "location" | "maxBytes">): string {
  return lockedJsonRevision(readLockedJsonBytes(options));
}

function readLockedJsonBytes(options: Pick<LockedJsonStoreOptions<unknown>, "location" | "maxBytes">): Buffer | undefined {
  return accountStorageOperation(options.location, () =>
    readFileUnder(options.location.baseDir, options.location.relativePath, { maxBytes: options.maxBytes ?? MAX_STORE_BYTES, noFollowBase: true }));
}

function decodeState<T>(bytes: Buffer | undefined, options: LockedJsonStoreOptions<T>): LockedJsonState<T> {
  const revision = lockedJsonRevision(bytes);
  if (bytes === undefined) return { tag: "absent", revision };
  try {
    return { tag: "valid", value: options.decode(JSON.parse(bytes.toString("utf-8"))), revision };
  } catch {
    return { tag: "malformed", revision };
  }
}

/** Secret-free identity of the exact admitted bytes, including absence. */
export function lockedJsonRevision(bytes: Buffer | undefined): string {
  const hash = createHash("sha256").update(bytes === undefined ? "absent" : "present");
  if (bytes !== undefined) hash.update(bytes);
  return hash.digest("hex");
}

/** Holds the lock through the mutation, including asynchronous credential generation. */
export async function mutateLockedJsonStore<T>(
  options: LockedJsonStoreOptions<T>,
  mutate: (value: T) => void | Promise<void>,
): Promise<void> {
  const { baseDir, relativePath } = options.location;
  const name = basename(relativePath);
  const directory = accountStorageOperation(options.location, () => {
    // The account data directory is created when this is the first account write.
    // A link already at its name survives this call and is then refused by the
    // no-follow open below, so creating it first cannot admit one.
    ensurePrivateRootDirectory(baseDir);
    return ContainedDirectory.open(baseDir, directoryComponents(dirname(relativePath)), { privateDirectories: true, noFollowBase: true });
  });
  try {
    let hold: LockHold;
    try {
      hold = await acquireLockIn(directory, `${name}.lock`);
    } catch (cause) {
      throw accountStorageAccessError(options.location, cause);
    }
    try {
      const bytes = accountStorageOperation(options.location, () => directory.readFile(name, options.maxBytes ?? MAX_STORE_BYTES));
      const state = decodeState(bytes, options);
      if (state.tag === "malformed") {
        throw new MalformedLockedJsonError({
          path: lockedJsonStorePath(options.location),
          message: `Cannot update malformed JSON store at ${lockedJsonStorePath(options.location)}. Repair or move the file and try again.`,
        });
      }
      const value = state.tag === "valid" ? state.value : options.empty();
      await mutate(value);
      const encoded = JSON.stringify(options.encode(value), null, 2);
      if (Buffer.byteLength(encoded) > (options.maxBytes ?? MAX_STORE_BYTES)) throw new RangeError(`JSON store exceeds ${options.maxBytes ?? MAX_STORE_BYTES} bytes`);
      accountStorageOperation(options.location, () => {
        const failure = directory.writeFile(name, encoded);
        if (failure !== undefined) throw failure;
      });
    } finally {
      accountStorageOperation(options.location, () => releaseLockIn(directory, hold));
    }
  } finally {
    directory.close();
  }
}
