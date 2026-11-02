/** The reader that turns one verified release archive into a payload tree.
 *
 *  The transfer hands this module only an archive whose size and SHA-256 the
 *  manifest stated and the transfer proved (`update-install.ts`), so every
 *  byte read here is one the release published. Each entry is confined to
 *  this attempt's tree as it is listed and spooled under a name this attempt
 *  owns; only once the whole listing is read does any archive name exist on
 *  disk, and then only through descriptor-contained no-follow operations
 *  (ARCH-DISTRIBUTION-011).
 *
 *  The archive is streamed, never held whole: one chunk of the stream, one
 *  header block, and one extended header are the whole working set. The
 *  client sets no limit of its own on what a verified archive holds. Every
 *  rule about that is the release side's (`scripts/release-acceptance.ts`). */

import * as path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { Schema } from "effect";
import type { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { Log } from "../../infra/log.js";
import { archiveTree, confinedEntryPath } from "../../infra/update/archive-entry.js";
import { BUILD_METADATA_FILE } from "../../infra/update/build-identity.js";

const log = Log.create({ service: "update-install" });

const PAYLOAD_DIR_NAME = "payload";

/** One tar header block, and the fields this reader takes from it. */
const TAR_BLOCK = 512;
const TAR_NAME_FIELD = { offset: 0, length: 100 } as const;
const TAR_MODE_FIELD = { offset: 100, length: 8 } as const;
const TAR_SIZE_FIELD = { offset: 124, length: 12 } as const;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_LINKNAME_FIELD = { offset: 157, length: 100 } as const;
const TAR_PREFIX_FIELD = { offset: 345, length: 155 } as const;

/** The verified archive does not hold a build this reader can place. */
export class UpdateArchiveError extends Schema.TaggedErrorClass<UpdateArchiveError>()("UpdateArchive", {
  message: Schema.String,
  reason: Schema.String,
}) {}

function refuse(reason: string): never {
  throw new UpdateArchiveError({ message: `The update could not be transferred: ${reason}`, reason });
}

/** Spool the archive and place it as the payload tree of `stagingDir`, and
 *  answer the path of the build inside it. */
export async function extractArchive(stagingDir: ContainedDirectory, spool: ContainedDirectory, archive: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<readonly string[]> {
  const listing = await spoolArchive(spool, archive, signal);
  writePayload(stagingDir, spool, listing);
  return [PAYLOAD_DIR_NAME, ...buildRoot(listing).split("/").filter((part) => part !== "")];
}

interface SpooledArchive {
  /** Every directory the payload holds, each after its parent. */
  readonly directories: readonly string[];
  /** Each file's relative path in the payload, and the name this attempt
   *  gave its bytes in the spool. */
  readonly files: ReadonlyMap<string, string>;
}

/** What one tar header describes, after the extended headers before it. */
type TarEntryKind = "file" | "directory" | "hard link" | "left out";

/** What extended headers state about the entry after them: a GNU long name
 *  or long link name, or a pax record. */
interface PendingAttributes {
  path?: string;
  linkPath?: string;
  sizeBytes?: number;
}

/** The directory of the archive that holds the build: the shallowest one
 *  with a `build.json`. The release decides where in its archive the build
 *  sits; today that is `flywheel-<target>/build`. */
function buildRoot(archive: SpooledArchive): string {
  const metadata = [...archive.files.keys()]
    .filter((file) => path.posix.basename(file) === BUILD_METADATA_FILE)
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  const shallowest = metadata[0];
  if (shallowest === undefined) refuse(`the archive holds no ${BUILD_METADATA_FILE}, so it holds no build`);
  return path.posix.dirname(shallowest) === "." ? "" : path.posix.dirname(shallowest);
}

/** Decompress the archive and put every file it lists in the spool.
 *  Placement is decided entry by entry, so an archive that would escape the
 *  tree is refused as it is read, and the whole listing is the answer an
 *  extraction writes from.
 *
 *  The reader takes every entry kind tar defines and places what can be
 *  placed on every platform without privilege: files, directories, and a hard
 *  link as the file it names. A symbolic link, a device, a FIFO, a sparse or
 *  multi-volume entry, and a hard link to nothing earlier are left out and
 *  counted in one record. Any type tar does not define is a regular file, as
 *  POSIX states. The staged build must still start before it is placed, so a
 *  build that needed an entry left out is refused by its run, never by its
 *  listing. */
async function spoolArchive(spool: ContainedDirectory, compressed: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<SpooledArchive> {
  const source = Readable.from(compressed);
  const gunzip = createGunzip();
  source.on("error", (error: Error) => { gunzip.destroy(error); });
  source.pipe(gunzip);
  const archive = new ArchiveWindow(gunzip);

  const tree = archiveTree();
  const files = new Map<string, string>();
  const leftOut = new Map<string, number>();
  let pending: PendingAttributes = {};
  let spooled = 0;
  try {
    for (;;) {
      const header = await archive.readHeader();
      if (!header || header.every((byte) => byte === 0)) break;
      const typeflag = String.fromCharCode(header[TAR_TYPEFLAG_OFFSET] ?? 0);
      const headerSize = numericField(header, TAR_SIZE_FIELD);

      // An extended header describes the entry after it rather than being one.
      const extended = extendedHeader(typeflag);
      if (extended !== undefined) {
        const data = await archive.read(headerSize);
        if (extended === "pax") Object.assign(pending, paxAttributes(data));
        if (extended === "long name") pending.path = nulTerminatedText(data);
        if (extended === "long link") pending.linkPath = nulTerminatedText(data);
        await archive.skip(paddingAfter(headerSize));
        continue;
      }

      const sizeBytes = pending.sizeBytes ?? headerSize;

      const entryPath = confinedEntryPath(pending.path ?? headerName(header));
      const linkPath = pending.linkPath ?? nulTerminated(header, TAR_LINKNAME_FIELD);
      pending = {};
      const kind = entryKind(typeflag);
      const linked = kind === "hard link" ? files.get(confinedEntryPath(linkPath)) : undefined;
      if (kind === "directory") {
        tree.directory(entryPath);
        await archive.skip(sizeBytes);
      } else if (kind === "file" || linked !== undefined) {
        tree.file(entryPath);
        const spoolName = String(spooled);
        spooled += 1;
        if (linked === undefined) {
          await spool.writeStreamExclusive(spoolName, archive.take(sizeBytes), { maxBytes: sizeBytes, mode: fileMode(header), signal });
        } else {
          spool.linkFile(linked, spoolName);
          await archive.skip(sizeBytes);
        }
        files.set(entryPath, spoolName);
      } else {
        const counted = kind === "hard link" ? "hard link to nothing earlier" : typeflag;
        leftOut.set(counted, (leftOut.get(counted) ?? 0) + 1);
        await archive.skip(sizeBytes);
      }
      await archive.skip(paddingAfter(sizeBytes));
    }
    // What follows the end-of-archive blocks is read through, so the gzip
    // stream ends where the file does.
    await archive.drain();
    if (leftOut.size > 0) log.info("update archive entries left out", { kinds: Object.fromEntries(leftOut) });
    return { directories: tree.directories(), files };
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

/** Create the payload tree the listing names, and move every spooled file
 *  into it. Each directory is opened relative to the descriptor of its
 *  parent, and each file is moved between two held descriptors, so no name in
 *  the archive can reach outside the tree this attempt owns. */
function writePayload(stagingDir: ContainedDirectory, spool: ContainedDirectory, archive: SpooledArchive): void {
  const payload = stagingDir.openChild(PAYLOAD_DIR_NAME);
  const opened = new Map<string, ContainedDirectory>();
  try {
    for (const directory of archive.directories) directoryFor(payload, opened, directory);
    for (const [file, spoolName] of archive.files) {
      const parent = directoryFor(payload, opened, path.posix.dirname(file));
      spool.renameInto(spoolName, parent, path.posix.basename(file));
    }
  } finally {
    for (const directory of opened.values()) directory.close();
    payload.close();
  }
}

/** The directory one relative path names, creating and holding every
 *  component. `"."` is the payload root itself, which the caller owns. */
function directoryFor(payload: ContainedDirectory, opened: Map<string, ContainedDirectory>, relativeDir: string): ContainedDirectory {
  if (relativeDir === "" || relativeDir === ".") return payload;
  const held = opened.get(relativeDir);
  if (held) return held;
  const parent = directoryFor(payload, opened, path.posix.dirname(relativeDir));
  const directory = parent.openChild(path.posix.basename(relativeDir));
  opened.set(relativeDir, directory);
  return directory;
}

/** One byte window over the decompressed archive. Nothing larger than one
 *  chunk of the stream, one header block, or one extended header is ever
 *  held. */
class ArchiveWindow {
  readonly #chunks: AsyncIterator<Uint8Array>;
  #held: Uint8Array = new Uint8Array(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#chunks = source[Symbol.asyncIterator]();
  }

  /** The next header block, or nothing when the archive ends here. */
  async readHeader(): Promise<Uint8Array | undefined> {
    if (!await this.#ready()) return undefined;
    return this.read(TAR_BLOCK);
  }

  /** Exactly `count` bytes, held together. Only a header block and an extended
   *  header are read this way; entry content is streamed. */
  async read(count: number): Promise<Uint8Array> {
    const held = new Uint8Array(count);
    let filled = 0;
    for await (const chunk of this.take(count)) {
      held.set(chunk, filled);
      filled += chunk.byteLength;
    }
    return held;
  }

  /** The next `count` bytes, chunk by chunk.
   *
   *  @yields {Uint8Array} one chunk of the entry, never more than what is left
   *  of it. */
  async *take(count: number): AsyncIterable<Uint8Array> {
    let remaining = count;
    while (remaining > 0) {
      if (!await this.#ready()) refuse("the archive ends inside an entry");
      const taken = Math.min(remaining, this.#held.byteLength);
      yield this.#held.subarray(0, taken);
      this.#held = this.#held.subarray(taken);
      remaining -= taken;
    }
  }

  /** Drop the next `count` bytes: the padding of one entry, or the content of
   *  one that lands nowhere. */
  async skip(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      if (!await this.#ready()) refuse("the archive ends inside an entry");
      const dropped = Math.min(remaining, this.#held.byteLength);
      this.#held = this.#held.subarray(dropped);
      remaining -= dropped;
    }
  }

  /** Read what the archive left behind, so the stream ends where it does. */
  async drain(): Promise<void> {
    while (await this.#ready()) this.#held = new Uint8Array(0);
  }

  /** Whether the window holds a byte, pulling one chunk when it does not. */
  async #ready(): Promise<boolean> {
    while (this.#held.byteLength === 0) {
      const next = await this.#chunks.next();
      if (next.done === true) return false;
      this.#held = next.value;
    }
    return true;
  }
}

/** The bytes that fill an entry of `sizeBytes` out to whole blocks. */
function paddingAfter(sizeBytes: number): number {
  return (TAR_BLOCK - sizeBytes % TAR_BLOCK) % TAR_BLOCK;
}

function headerName(header: Uint8Array): string {
  const name = nulTerminated(header, TAR_NAME_FIELD);
  const prefix = nulTerminated(header, TAR_PREFIX_FIELD);
  return prefix === "" ? name : `${prefix}/${name}`;
}

function nulTerminated(header: Uint8Array, field: { readonly offset: number; readonly length: number }): string {
  return nulTerminatedText(header.subarray(field.offset, field.offset + field.length));
}

function nulTerminatedText(raw: Uint8Array): string {
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}

/** A numeric header field: octal text, or the base-256 form GNU and pax
 *  writers use for a value too large for the field. A field that is
 *  neither states no size, so the entry after it cannot be found. */
function numericField(header: Uint8Array, field: { readonly offset: number; readonly length: number }): number {
  const raw = header.subarray(field.offset, field.offset + field.length);
  if (((raw[0] ?? 0) & 0x80) !== 0) {
    let value = (raw[0] ?? 0) & 0x7f;
    for (const byte of raw.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = nulTerminatedText(raw).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) refuse("an archive entry states a size that is not a number");
  return Number.parseInt(text, 8);
}

/** The mode a placed file takes: executable when the entry's owner may
 *  execute it, and plain otherwise. A mode the entry does not state readably
 *  places a plain file. */
function fileMode(header: Uint8Array): number {
  const text = nulTerminated(header, TAR_MODE_FIELD).trim();
  return /^[0-7]+$/.test(text) && (Number.parseInt(text, 8) & 0o100) !== 0 ? 0o755 : 0o644;
}

/** The extended header a typeflag names, if it names one. A global pax
 *  header (`g`) describes the archive, not one entry, and states nothing
 *  this reader places, so it is read past like the others. */
function extendedHeader(typeflag: string): "pax" | "long name" | "long link" | "global" | undefined {
  switch (typeflag) {
    case "x":
      return "pax";
    case "L":
      return "long name";
    case "K":
      return "long link";
    case "g":
      return "global";
    default:
      return undefined;
  }
}

/** What one tar typeflag places. */
function entryKind(typeflag: string): TarEntryKind {
  switch (typeflag) {
    case "5":
    case "D":
      return "directory";
    case "1":
      return "hard link";
    case "2":
    case "3":
    case "4":
    case "6":
    case "S":
    case "V":
    case "M":
      return "left out";
    default:
      return "file";
  }
}

/** The pax records that change the entry after them: its path, its link
 *  target, and its size. A record is `"<length> <key>=<value>\n"`, where the
 *  length counts the whole record, so a value may hold any byte. */
function paxAttributes(data: Uint8Array): PendingAttributes {
  const attributes: PendingAttributes = {};
  const text = Buffer.from(data);
  let offset = 0;
  while (offset < text.byteLength) {
    const space = text.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number(text.subarray(offset, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > text.byteLength) break;
    const record = text.subarray(space + 1, offset + length - 1).toString("utf8");
    offset += length;
    const equals = record.indexOf("=");
    if (equals < 0) continue;
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") attributes.path = value;
    if (key === "linkpath") attributes.linkPath = value;
    if (key === "size" && /^\d+$/.test(value)) attributes.sizeBytes = Number(value);
  }
  return attributes;
}
