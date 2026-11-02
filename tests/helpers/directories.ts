import { afterAll, afterEach, onTestFinished } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDirectory, FLYWHEEL_DIR_NAME, type StartupDirectories } from "../../src/infra/directory-authorities.js";
import { removeWhenReleased } from "./remove-when-released.js";

let accountHome: string | undefined;

/** Process-shared account resources released before their home is removed. */
export const testAccountResources = new AsyncDisposableStack();

/** An isolated account home for this test process, created under the OS temp
 *  directory. Tests never read or write the developer's own account state, so
 *  what a registry or store observes is only what the test installed. */
export function testAccountHome(): string {
  accountHome ??= mkdtempSync(join(tmpdir(), "flywheel-test-account-"));
  return accountHome;
}

/** Releases account resources and removes the home after every test file runs.
 *  The preload calls it from a global `afterAll`, because `bun test` never
 *  emits the process `exit` event that would otherwise carry the cleanup.
 *  A release failure leaves the home intact and fails that hook. */
export async function removeTestAccountHome(): Promise<void> {
  await testAccountResources.disposeAsync();
  if (accountHome === undefined) return;
  // Processes that tests start, such as the Claude CLI, run with this home,
  // and Windows releases an exited process's handles in it a moment later.
  removeWhenReleased(accountHome);
  accountHome = undefined;
}

/** A factory for temporary directories that the calling test file or
 *  `describe` block owns. Each directory is removed after the case that
 *  created it, whether the case passed or failed, and at the latest when the
 *  scope ends. Call it once at the top level of the file or block, never
 *  inside a test, because it registers an `afterEach` and an `afterAll` hook
 *  in that scope.
 *
 *  The removal runs after every `afterEach` hook of the case, also after a
 *  hook that the file registers later. Bun runs the hooks of one scope in
 *  registration order, and a file usually calls this factory before it
 *  registers the hook that closes a store or stops a process inside the
 *  directory. Windows refuses to remove a file that is still open (EBUSY), so
 *  the removal waits for `onTestFinished`, which Bun runs after all hooks.
 *
 *  Bun skips the `onTestFinished` callbacks of a case when one of its
 *  `afterEach` hooks throws. The `afterAll` hook then removes every directory
 *  that is still recorded, so the failed hook does not also leak a directory.
 *
 *  `bun run test` gives each test process its own TMPDIR and fails the run
 *  when anything is left in it, so a directory that no hook removes is a
 *  failure even when every case passes. */
export function temporaryDirectories(): (prefix: string) => string {
  const created: string[] = [];
  const removeCreated = (): void => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  };
  afterEach(() => {
    onTestFinished(removeCreated);
  });
  afterAll(removeCreated);
  return (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  };
}

/** The directory to create a temporary directory in when a Unix socket will
 *  be bound inside it. A Unix socket path must stay under 104 bytes, and the
 *  private TMPDIR of a test process on macOS is too deep for that, so a POSIX
 *  host uses `/tmp`. Flywheel listens on named pipes on Windows, where `/tmp`
 *  names a folder on the current drive that need not exist, so Windows uses
 *  the test process's own TMPDIR, which the leak guard of `bun run test`
 *  watches. */
export function socketTemporaryRoot(): string {
  // oxlint-disable-next-line flywheel/no-tmp-literal-path -- a Unix socket path in this directory must stay under 104 bytes
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/** A temporary directory that the calling test file owns for all of its cases,
 *  for a fixture whose paths are module constants. It is removed after the
 *  last case of the file. Call it at the top level of the file, never inside
 *  a test, because it registers an `afterAll` hook in that scope. Prefer
 *  `temporaryDirectories()` when each case can take a directory of its own. */
export function fileTemporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The directory authorities the CLI would publish for a test whose project and
 *  execution directories are the same, with the isolated account home above. */
export function testDirectories(projectRoot: string, executionCwd: string = projectRoot): StartupDirectories {
  const home = testAccountHome();
  return {
    projectRoot: canonicalTestDirectory(projectRoot),
    executionCwd: canonicalTestDirectory(executionCwd),
    accountHome: home,
    userDataRoot: join(home, FLYWHEEL_DIR_NAME),
  };
}

/** The CLI canonicalizes every authority it publishes, so a fixture publishes
 *  canonical paths too: `/tmp` is a link on this platform, and Flywheel owns the
 *  project root's own name, which it therefore never follows. A directory a case
 *  has not created yet is published as given, because a start creates its own
 *  project root. A case that asserts on a published authority compares against
 *  this value, not against the temporary path it created. */
export function canonicalTestDirectory(directory: string): string {
  return existsSync(directory) ? canonicalDirectory(directory, "test directory") : directory;
}

/** A canonical execution directory for a fixture that needs session metadata
 *  only to be well formed.
 *
 *  `/tmp` is not one. Session metadata states a canonical absolute directory
 *  (ARCH-DIRECTORIES-006), and a canonical path is one that equals its own resolution: on
 *  Windows `/tmp` resolves onto the current drive, so a fixture that writes
 *  `/tmp` writes metadata every reader quarantines. */
export const FIXTURE_EXECUTION_CWD: string = resolve(tmpdir());
