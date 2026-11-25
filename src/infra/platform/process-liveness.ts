/** Whether one process id still names a running process.
 *
 *  Signal zero performs every permission check and delivers nothing, so it is
 *  the one portable answer to "is that pid taken". Only `ESRCH` means the pid
 *  is free: a refusal (`EPERM`) is a process that exists and belongs to
 *  another user, and reporting it as gone is what lets a caller reclaim
 *  something a live process still owns.
 *
 *  A pid the operating system already recycled reads as alive. Every caller
 *  here is deciding whether to reclaim a resource, so that is the safe
 *  direction: the cost is a resource held longer than it had to be, never a
 *  resource taken from under a running process.
 *
 *  This is the whole of the answer, so it is the whole of this module. A probe
 *  that also compares a process identity - the watchdog waiting on its parent,
 *  the supervisor waiting on its container leader - is answering a different
 *  question ("is that *the same* process") and owns its own predicate. */

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
