/** Whether this platform can stage the failures these cases need.
 *
 *  Two POSIX facilities are used to put the code under test into a failing
 *  state, and Windows provides neither:
 *
 *  A mode change. `chmod` makes a directory unreadable or unwritable on POSIX,
 *  and Windows ignores it: the read or write simply succeeds, so the case has no
 *  failure to observe. Windows holds privacy through ACLs instead, which
 *  windows-private-directory-acl.test.ts covers.
 *
 *  A directory fsync. `fsyncDirectory` in src/infra/atomic-write.ts returns
 *  early on Windows because the platform has no portable directory sync
 *  boundary, so a case that injects a failing directory sync, or asserts one
 *  happened, describes a step that does not run there.
 *
 *  Skipping is the honest outcome: the premise cannot exist, so passing would
 *  mean asserting nothing. */
export const POSIX_FAILURE_STAGING = process.platform !== "win32";
