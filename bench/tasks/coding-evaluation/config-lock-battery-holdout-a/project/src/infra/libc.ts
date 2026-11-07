import { dlopen, type FFIFunction, FFIType, type Library, type Pointer, read, toArrayBuffer } from "bun:ffi";
import { constants as osConstants } from "node:os";

/** C libraries that export the POSIX calls Flywheel binds, in the order they
 *  are tried. Only one matches a given platform; a platform where none loads
 *  has no safe descriptor-rooted filesystem access at all. */
const LIBC_CANDIDATES = process.platform === "darwin"
  ? ["libSystem.B.dylib"]
  : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];

/** Why this platform has no binding. There is no path-based fallback: a caller
 *  must refuse to serve the files it guards rather than serve them unsafely. */
export const NO_LIBC_REASON = `this platform (${process.platform}) exposes no descriptor-relative filesystem calls, so files under a directory it does not control cannot be read safely`;

/** Bind symbols from the platform C library, or undefined when no candidate
 *  library exports all of them. A missing symbol fails the whole binding, so a
 *  caller that wants one of several symbol variants asks for each variant in
 *  its own call. The thread's `errno` slot is bound with them, because
 *  `dlopen` sets `errno` itself: binding it after a failed call would report
 *  the probe's code instead of the call's. */
interface FfiFunctions { [symbol: string]: FFIFunction }

export function bindLibc<Fns extends FfiFunctions>(symbols: Fns): Library<Fns>["symbols"] | undefined {
  const bound = dlopenAny(symbols);
  if (bound !== undefined) bindErrnoSlot();
  return bound;
}

function dlopenAny<Fns extends FfiFunctions>(symbols: Fns): Library<Fns>["symbols"] | undefined {
  for (const library of LIBC_CANDIDATES) {
    try {
      return dlopen(library, symbols).symbols;
    } catch {
      continue;
    }
  }
  return undefined;
}

const ERRNO_CODES = new Map<number, string>(
  Object.entries(osConstants.errno).map(([code, value]) => [value, code]),
);

/** The thread's `errno` slot accessor (`__error` on darwin,
 *  `__errno_location` elsewhere), or null on a platform with no binding. Bun's
 *  FFI reports only a call's return value, so without this slot an escape
 *  attempt and an uninstalled file are the same failure. */
let errnoSlot: (() => Pointer | null) | null | undefined;

function bindErrnoSlot(): void {
  if (errnoSlot !== undefined) return;
  // Claimed before the bind below, so the accessor's own binding does not
  // re-enter this function.
  errnoSlot = null;
  const bound = process.platform === "darwin"
    ? dlopenAny({ __error: { args: [], returns: FFIType.ptr } })
    : dlopenAny({ __errno_location: { args: [], returns: FFIType.ptr } });
  if (bound !== undefined) errnoSlot = "__error" in bound ? bound.__error : bound.__errno_location;
}

function errnoLocation(): Pointer | null {
  bindErrnoSlot();
  return errnoSlot?.() ?? null;
}

/** `errno` of the calling thread, or 0 where there is no slot to read. */
export function libcErrno(): number {
  const location = errnoLocation();
  return location === null ? 0 : read.i32(location, 0);
}

/** Clear `errno` before a call whose failure is only distinguishable by it: a
 *  `readdir` returns NULL both at the end of a directory and on an error. */
export function clearLibcErrno(): void {
  const location = errnoLocation();
  if (location === null) return;
  new Int32Array(toArrayBuffer(location, 0, 4))[0] = 0;
}

/** An `Error` naming the failed call and carrying the libc `code` (`ENOENT`,
 *  `ELOOP`, ...), and never a resolved path: the caller decides what identity
 *  is safe to name. */
export function libcError(operation: string): Error {
  const errno = libcErrno();
  const code = ERRNO_CODES.get(errno) ?? "UNKNOWN";
  return Object.assign(new Error(`${operation} failed with ${code}`), { code, errno, operation });
}
