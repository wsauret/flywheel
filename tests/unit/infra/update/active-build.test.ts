/** The account's one activation: the contained directory's link at
 *  `current`, a symlink on macOS and Linux and on Windows the pointer file
 *  the Windows launcher reads. The Windows backend is path-held, so its
 *  pointer is proved on every host. */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js";
import { currentBuildLink, versionsDir } from "../../../../src/infra/paths.js";
import { ActivationError, activeBuildDir, openActiveBuild, publishActivation } from "../../../../src/infra/update/active-build.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js";

const temporaryDirectory = temporaryDirectories();

const FIRST = { version: "0.0.10", buildId: "a".repeat(64) };
const SECOND = { version: "0.0.11", buildId: "b".repeat(64) };

function account(): string {
  const userDataRoot = path.join(temporaryDirectory("flywheel-active-build-"), ".flywheel");
  for (const build of [FIRST, SECOND]) fs.mkdirSync(path.join(versionsDir(userDataRoot), build.version, build.buildId), { recursive: true });
  return userDataRoot;
}

function withAccountRoot<T>(userDataRoot: string, use: (accountRoot: ContainedDirectory) => T): T {
  const accountRoot = ContainedDirectory.open(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  try {
    return use(accountRoot);
  } finally {
    accountRoot.close();
  }
}

function activate(userDataRoot: string, build: typeof FIRST): void {
  withAccountRoot(userDataRoot, (accountRoot) => { publishActivation(accountRoot, userDataRoot, build); });
}

function pointedDir(userDataRoot: string): string | undefined {
  return withAccountRoot(userDataRoot, (accountRoot) => {
    const active = openActiveBuild(accountRoot, userDataRoot);
    active?.directory.close();
    return active?.path;
  });
}

function activationContract(): void {
  test("names no build before the first activation", () => {
    const userDataRoot = account();

    expect(pointedDir(userDataRoot)).toBeUndefined();
    expect(activeBuildDir(userDataRoot)).toBeUndefined();
  });

  test("names the build the latest activation published, and leaves no private name beside it", () => {
    const userDataRoot = account();
    activate(userDataRoot, FIRST);
    activate(userDataRoot, SECOND);

    const expected = fs.realpathSync(path.join(versionsDir(userDataRoot), SECOND.version, SECOND.buildId));
    expect(pointedDir(userDataRoot)).toBe(expected);
    expect(activeBuildDir(userDataRoot)).toBe(expected);
    expect(fs.readdirSync(userDataRoot).sort()).toEqual(["current", "versions"]);
  });
}

describe("the activation on this host's backend", activationContract);

describe("the activation on the Windows backend", () => {
  useWin32ContainedDirectories();
  activationContract();

  test("is the relative build directory the launcher reads, with no prefix and no byte order mark", () => {
    const userDataRoot = account();
    activate(userDataRoot, FIRST);

    expect(fs.readFileSync(currentBuildLink(userDataRoot), "utf8")).toBe(`versions\\${FIRST.version}\\${FIRST.buildId}`);
  });

  test.each([
    ["a path outside the versions root", `..\\versions\\${FIRST.version}\\${FIRST.buildId}`],
    ["an absolute path", `C:\\versions\\${FIRST.version}\\${FIRST.buildId}`],
    ["a directory one level too shallow", `versions\\${FIRST.version}`],
  ])("refuses %s rather than name a build", (_case, text) => {
    const userDataRoot = account();
    fs.writeFileSync(currentBuildLink(userDataRoot), text);

    expect(() => pointedDir(userDataRoot)).toThrow(ActivationError);
    expect(activeBuildDir(userDataRoot)).toBeUndefined();
  });

  test("names nothing for a build that is not installed", () => {
    const userDataRoot = account();
    fs.writeFileSync(currentBuildLink(userDataRoot), `versions\\${FIRST.version}\\${"c".repeat(64)}`);

    expect(pointedDir(userDataRoot)).toBeUndefined();
  });
});
