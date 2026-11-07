import { FFIType } from "bun:ffi";
import { bindLibc, libcError, NO_LIBC_REASON } from "./libc.js";

/** The bound `openat`, or null when this platform has none. Bound once: a
 *  platform that cannot bind it never can. */
let openat: ((dirFd: number, name: Buffer, flags: number) => number) | null | undefined;

/** Open one path component relative to an already open directory.
 *
 *  This is the only primitive that closes the check-then-use gap in a walk down
 *  a directory tree the process does not control. A path-based open re-resolves
 *  every component at call time, so a directory renamed between two opens
 *  redirects the next open into another tree, whatever the walker checked
 *  before. `openat` resolves one component against a descriptor the caller has
 *  already verified, and renaming a directory does not move the descriptor.
 *
 *  Neither Node nor Bun exposes `openat`, so it is bound from the platform C
 *  library. There is no path-based fallback: on a platform where the binding
 *  fails, including Windows, which has no `openat`, this throws and the caller
 *  must refuse to serve the files it guards rather than serve them unsafely.
 *
 *  `name` is one component: `""`, `"."`, `".."`, a separator, or a NUL is
 *  refused, because each of those would make the open mean something other than
 *  "this entry of that directory". Returns a file descriptor the caller owns and
 *  must close. Throws an `Error` carrying the libc `code` (`ENOENT`, `ELOOP`,
 *  ...), and never the resolved path: the caller decides what identity is safe
 *  to name. */
export function openAt(dirFd: number, name: string, flags: number): number {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`openAt takes one path component, not ${JSON.stringify(name)}`);
  }

  const fd = bindOpenAt()(dirFd, Buffer.from(`${name}\0`, "utf8"), flags);
  if (fd >= 0) return fd;
  throw Object.assign(libcError("openat"), { flags });
}

function bindOpenAt(): (dirFd: number, name: Buffer, flags: number) => number {
  if (openat === undefined) {
    const bound = bindLibc({ openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 } });
    openat = bound?.openat ?? null;
  }
  if (openat === null) throw new Error(NO_LIBC_REASON);
  return openat;
}
