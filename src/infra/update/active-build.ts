/** Which installed build the account runs: the one activation every launch,
 *  every installer, and every collector reads.
 *
 *  One link under the account data root, `current`, names one build directory
 *  under the versions root, `versions/<version>/<build id>` (ARCH-DISTRIBUTION-017). It is
 *  the contained directory's link on every platform (`publishLink` and
 *  `openLinkedChild`): a relative symlink on macOS and Linux, which the POSIX
 *  wrapper resolves physically before it runs anything, and on Windows a
 *  pointer file whose text is that path, which the Windows launcher
 *  (`crates/windows-launcher/launcher.c`) reads before it runs
 *  `flywheel-bin.exe` from the directory it names. Either is written under a
 *  private name and renamed over `current`, so a reader sees the old build or
 *  the new one and never a missing or torn activation. */

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { ContainedDirectory } from "../descriptor-directory.js";
import { errorMessage } from "../error-message.js";
import { CURRENT_BUILD_LINK, versionsDir } from "../paths.js";
import type { BuildRef } from "./build-identity.js";

/** The private name an activation is written under before its rename,
 *  `.current.<pid>.<hex>`. The pid names its writer, so a collector removes
 *  one that an interrupted activation left once that writer is gone. */
export const PENDING_ACTIVATION = /^\.current\.([1-9][0-9]*)\.[0-9a-f]{16}$/;

/** `current` does not name an installed build. */
export class ActivationError extends Schema.TaggedError<ActivationError>()("Activation", {
  message: Schema.String,
}) {}

function refuse(message: string): never {
  throw new ActivationError({ message });
}

/** Make `build` the account's active build. The caller holds the account
 *  update lease and has proved the build is installed. */
export function publishActivation(accountRoot: ContainedDirectory, userDataRoot: string, build: BuildRef): void {
  const pending = `.${CURRENT_BUILD_LINK}.${process.pid}.${randomBytes(8).toString("hex")}`;
  accountRoot.publishLink(pending, CURRENT_BUILD_LINK, path.posix.join(path.basename(versionsDir(userDataRoot)), build.version, build.buildId));
}

/** The active build, held open, with the physical path of its directory. */
export interface ActiveBuild {
  readonly directory: ContainedDirectory;
  readonly path: string;
}

/** The build `current` selects, held open, or nothing when there is no
 *  activation or it names nothing. A `current` that names anything but a
 *  directory exactly two components below the account's versions root is
 *  refused with an `ActivationError`. The caller closes the directory.
 *
 *  The metadata inside it is the caller's to prove against the path, because
 *  what a proof needs differs: activation proves the version it compares, a
 *  collector needs only the build id. */
export function openActiveBuild(accountRoot: ContainedDirectory, userDataRoot: string): ActiveBuild | undefined {
  let linked: ContainedDirectory | undefined;
  try {
    linked = accountRoot.openLinkedChild(CURRENT_BUILD_LINK);
  } catch (error) {
    refuse(`the current build does not resolve to a usable build: ${errorMessage(error)}`);
  }
  if (!linked) return undefined;
  try {
    const target = linked.canonicalPath();
    linked.requireSamePathAs(target);
    if (path.dirname(path.dirname(target)) !== realpathSync(versionsDir(userDataRoot))) {
      refuse(`the current build resolves to ${JSON.stringify(target)}, which is not an installed build directory`);
    }
    return { directory: linked, path: target };
  } catch (error) {
    linked.close();
    if (error instanceof ActivationError) throw error;
    refuse(`the current build does not resolve to a usable build: ${errorMessage(error)}`);
  }
}

/** The physical directory of the account's active build, or nothing when
 *  there is no activation or it does not name an installed build. A caller
 *  that must tell those two apart uses `openActiveBuild`. */
export function activeBuildDir(userDataRoot: string): string | undefined {
  let accountRoot: ContainedDirectory | undefined;
  try {
    accountRoot = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
    if (!accountRoot) return undefined;
    const active = openActiveBuild(accountRoot, userDataRoot);
    active?.directory.close();
    return active?.path;
  } catch {
    return undefined;
  } finally {
    accountRoot?.close();
  }
}
