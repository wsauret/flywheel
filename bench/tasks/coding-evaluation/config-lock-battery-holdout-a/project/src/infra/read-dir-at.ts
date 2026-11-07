import { CString, FFIType, type Pointer, read } from "bun:ffi";
import { closeSync } from "node:fs";
import { bindLibc, clearLibcErrno, libcErrno, libcError, NO_LIBC_REASON } from "./libc.js";

type DirectoryEntryType = "directory" | "file" | "symlink" | "other";

export interface DirectoryEntry {
  /** One path component: the entry's name in its own directory. */
  readonly name: string;
  /** The kind the directory itself records. A filesystem that records none
   *  reports `other`, exactly as a `readdir` with file types does. */
  readonly type: DirectoryEntryType;
}

/** Source of one open directory's entries. `readDirAt` is the filesystem one;
 *  a caller that must exercise a walk's bounds substitutes a stream it
 *  controls. */

/** `d_type` values of the entry kinds a walk distinguishes: DT_DIR, DT_REG,
 *  and DT_LNK. Every other kind, DT_UNKNOWN included, is `other`. */
const ENTRY_TYPES = new Map<number, DirectoryEntryType>([[4, "directory"], [8, "file"], [10, "symlink"]]);

/** Byte offsets inside `struct dirent`, which differs per platform. darwin's
 *  64-bit-inode layout is `d_ino`, `d_seekoff`, `d_reclen`, `d_namlen`,
 *  `d_type`, `d_name`; Linux's is `d_ino`, `d_off`, `d_reclen`, `d_type`,
 *  `d_name`. The layout must match the `readdir` variant that is bound below,
 *  never the platform alone. */
const DIRENT = process.platform === "darwin"
  ? { type: 20, name: 21 }
  : { type: 18, name: 19 };

interface DirectoryStream {
  dup(fd: number): number;
  lseek(fd: number, offset: number, whence: number): number | bigint;
  fdopendir(fd: number): Pointer | null;
  readdir(stream: Pointer): Pointer | null;
  closedir(stream: Pointer): number;
}

let stream: DirectoryStream | null | undefined;

/** Yield the entries of an already open directory, one at a time.
 *
 *  This is the enumeration half of what `openAt` gives a walk down a tree the
 *  process does not control: the entries come from the descriptor the caller
 *  already verified, so a directory renamed or replaced under its path cannot
 *  substitute another tree's contents, which is what a path-based `readdir`
 *  cannot promise. It is also incremental, so a caller that needs a bounded
 *  number of entries never materializes a directory of any size: Bun's
 *  `readdirSync` and `opendirSync` both scan the whole directory before the
 *  first entry is available.
 *
 *  `.` and `..` are not the directory's contents and are never yielded. The
 *  descriptor stays the caller's to close: the stream reads a duplicate of it.
 *  Throws an `Error` carrying the libc `code`, and never a path.
 *
 *  @yields {DirectoryEntry} one entry of the directory, in directory order. */
export function* readDirAt(dirFd: number): Generator<DirectoryEntry> {
  const libc = bindDirectoryStream();
  const duplicate = libc.dup(dirFd);
  if (duplicate < 0) throw libcError("dup");

  // A duplicate shares the file description, and with it the directory read
  // offset, so the stream is rewound before `fdopendir` takes it: a second
  // walk of one descriptor must start at the first entry, not where the
  // previous walk stopped.
  if (libc.lseek(duplicate, 0, 0) < 0) {
    closeSync(duplicate);
    throw libcError("lseek");
  }

  const directory = libc.fdopendir(duplicate);
  if (directory === null) {
    closeSync(duplicate);
    throw libcError("fdopendir");
  }

  try {
    for (;;) {
      clearLibcErrno();
      const entry = libc.readdir(directory);
      if (entry === null) {
        if (libcErrno() !== 0) throw libcError("readdir");
        return;
      }
      const name = String(new CString(entry, DIRENT.name));
      if (name === "." || name === "..") continue;
      yield { name, type: ENTRY_TYPES.get(read.u8(entry, DIRENT.type)) ?? "other" };
    }
  } finally {
    libc.closedir(directory);
  }
}

const DUP = { args: [FFIType.i32], returns: FFIType.i32 } as const;
const LSEEK = { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 } as const;
const FDOPENDIR = { args: [FFIType.i32], returns: FFIType.ptr } as const;
const READDIR = { args: [FFIType.ptr], returns: FFIType.ptr } as const;
const CLOSEDIR = { args: [FFIType.ptr], returns: FFIType.i32 } as const;

/** Bind the directory-stream calls. darwin keeps the 64-bit-inode `readdir`
 *  under a suffixed symbol on x86_64 and under the plain name on arm64, and
 *  the two report different `struct dirent` layouts, so the suffixed pair is
 *  tried first and the plain pair is only ever the arm64 one. Bound once: a
 *  platform that cannot bind it never can. */
function bindDirectoryStream(): DirectoryStream {
  if (stream === undefined) stream = loadDirectoryStream();
  if (stream === null) throw new Error(NO_LIBC_REASON);
  return stream;
}

function loadDirectoryStream(): DirectoryStream | null {
  const common = { dup: DUP, lseek: LSEEK, closedir: CLOSEDIR };
  const suffixed = bindLibc({ ...common, "fdopendir$INODE64": FDOPENDIR, "readdir$INODE64": READDIR });
  if (suffixed) {
    return {
      dup: suffixed.dup,
      lseek: suffixed.lseek,
      closedir: suffixed.closedir,
      fdopendir: suffixed["fdopendir$INODE64"],
      readdir: suffixed["readdir$INODE64"],
    };
  }
  const plain = bindLibc({ ...common, fdopendir: FDOPENDIR, readdir: READDIR });
  if (plain === undefined) return null;
  return { dup: plain.dup, lseek: plain.lseek, closedir: plain.closedir, fdopendir: plain.fdopendir, readdir: plain.readdir };
}
