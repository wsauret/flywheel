/** Whether this platform keeps POSIX permission bits.
 *
 *  Windows keeps none. `stat` reports the same mode there whatever a write
 *  asked for, so comparing modes on Windows proves something about Node's
 *  emulation rather than about what the code requested of the filesystem. A
 *  case that exists to prove a restrictive mode therefore asserts it only where
 *  the mode is real.
 *
 *  This is not a coverage gap for Windows privacy: privacy there is held by the
 *  owner-only ACL, which `windowsDirectoryIsOwnerOnly` proves and
 *  windows-private-directory-acl.test.ts covers. */
export const POSIX_FILE_MODES = process.platform !== "win32";
