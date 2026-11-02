import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRIVATE_TEMPORARY_ROOT_STEMS, privateTemporaryRootName } from "../src/infra/private-temporary-root.js";
import { removeWhenReleased } from "../tests/helpers/remove-when-released.js";

// Flywheel keeps these roots in the temporary directory for good and removes
// only what is in them, so the guard reports their contents, not the roots.
const PERSISTENT_ROOTS: ReadonlySet<string> = new Set(PRIVATE_TEMPORARY_ROOT_STEMS.map(privateTemporaryRootName));

/** The variables that name the temporary directory: `os.tmpdir()` reads
 *  TMPDIR on POSIX and TEMP or TMP on Windows. */
interface TempDirEnv {
  readonly TMPDIR: string;
  readonly TEMP: string;
  readonly TMP: string;
}

/** One leaked temporary tree: the test process that left it and what it left. */
export interface TempLeak {
  readonly label: string;
  readonly names: readonly string[];
}

/**
 * A private temporary directory for each test process of one validation run.
 *
 * A test that creates a temporary entry and never removes it fills the
 * developer's TMPDIR a little on every run, and nothing else ever notices. Each
 * `bun test` process gets its own empty directory as TMPDIR, so everything it
 * leaves behind is its own: other sessions and services that write the real
 * TMPDIR at the same time cannot make a clean run fail or hide a leak. The
 * guard always removes the directories it made, so a failed run leaks nothing
 * either.
 *
 * The paths stay short, a numbered directory in a short root, because a Unix
 * socket path is limited to about 104 bytes and tests and the code they run
 * place sockets in their temporary directories.
 *
 * The root is the physical path of the temporary directory. Flywheel records
 * the physical path of every file it resolves, and a test compares that with
 * a path it built from TMPDIR. A temporary directory can have another
 * spelling: on macOS it is under the `/var` link, and on a Windows CI runner
 * TEMP names the user directory by its 8.3 short name (`RUNNER~1`), which
 * only the native realpath expands.
 */
export function createTestTempGuard(root: string = tmpdir()) {
  const runRoot = mkdtempSync(join(realpathSync.native(root), "fwt-"));
  const dirs = new Map<string, string>();
  let made = 0;
  return {
    /** The environment that points every temporary-directory lookup of the
     *  test process named `label` at its own empty directory. */
    env(label: string): TempDirEnv {
      const dir = join(runRoot, String(++made));
      mkdirSync(dir);
      dirs.set(label, dir);
      return { TMPDIR: dir, TEMP: dir, TMP: dir };
    },
    /** Reads what one finished test process left behind, then removes it. */
    collect(label: string): TempLeak | undefined {
      const dir = dirs.get(label);
      if (dir === undefined) throw new Error(`no temporary directory was made for ${label}`);
      dirs.delete(label);
      const names = readdirSync(dir)
        .flatMap((name) => PERSISTENT_ROOTS.has(name) ? readdirSync(join(dir, name)).map((child) => `${name}/${child}`) : [name])
        .toSorted();
      rmSync(dir, { recursive: true, force: true });
      return names.length > 0 ? { label, names } : undefined;
    },
    /** Removes every directory the guard made. A test process that was
     *  killed can still hold its directory busy on Windows for a moment after
     *  it exits, so the removal retries within a bound and throws when the
     *  directory is never released. */
    dispose(): void {
      removeWhenReleased(runRoot);
    },
  };
}

/** The name a leaked entry was created from: `mkdtemp` appends six random
 *  characters to its prefix, and that prefix is what a search of the tests
 *  finds. A name without that suffix is its own prefix. */
export function tempEntryPrefix(name: string): string {
  return name.replace(/(?<=[-_ .])[A-Za-z0-9]{6}$/, "*");
}

/** The failure text for leaked temporary entries, grouped by prefix with the
 *  test processes that left each one. */
export function formatTempLeaks(leaks: readonly TempLeak[]): string {
  const groups = new Map<string, { count: number; labels: Set<string> }>();
  for (const leak of leaks) {
    for (const name of leak.names) {
      const prefix = tempEntryPrefix(name);
      const group = groups.get(prefix) ?? { count: 0, labels: new Set() };
      group.count++;
      group.labels.add(leak.label);
      groups.set(prefix, group);
    }
  }
  const total = leaks.reduce((sum, leak) => sum + leak.names.length, 0);
  const lines = [`\nTests left ${total} temporary entr${total === 1 ? "y" : "ies"} in TMPDIR. Remove each one in afterEach, afterAll, or finally:`];
  for (const [prefix, group] of [...groups].toSorted(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  ${prefix} (${group.count}, ${[...group.labels].join(" ")})`);
  }
  return `${lines.join("\n")}\n`;
}
