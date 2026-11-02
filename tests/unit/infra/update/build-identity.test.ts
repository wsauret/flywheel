import { afterAll, describe, expect, test } from "bun:test";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { currentBuildLink, versionsDir } from "../../../../src/infra/paths.js";
import {
  BUILD_METADATA_FILE,
  BuildIdentityError,
  assertInstallLocation,
  buildIdentityBeside,
  buildInstallDir,
  computeBuildId,
  decodeBuildMetadata,
  versionLine,
} from "../../../../src/infra/update/build-identity.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-build-identity-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BUILD_ID = "a".repeat(64);

function metadata(overrides: { [key: string]: unknown } = {}): string {
  return JSON.stringify({ version: "1.2.3", buildId: BUILD_ID, ...overrides });
}

let trees = 0;
/** One build tree written from a description of its files. A value is file
 *  contents; `null` names an empty directory. */
function tree(entries: { [path: string]: string | null }, mode: { [path: string]: number } = {}): string {
  trees += 1;
  const root = path.join(TMP, `tree-${trees}`);
  for (const [relative, contents] of Object.entries(entries)) {
    const full = path.join(root, relative);
    if (contents === null) {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, { mode: mode[relative] ?? 0o644 });
  }
  return root;
}

const PAYLOAD = {
  "flywheel-bin": "binary bytes",
  "native/darwin-arm64/libx.dylib": "native bytes",
  "fonts/monaspace-argon/font.otf": "font bytes",
} satisfies { [path: string]: string | null };

describe("build metadata", () => {
  test("metadata names the version and build, whatever else a later release states in it", () => {
    expect(decodeBuildMetadata(metadata({ generator: "reserved", asset: "flywheel-freebsd-x64.zip", notes: "x".repeat(64 * 1024) }))).toEqual({
      version: { canonical: "1.2.3", precedence: { core: [1, 2, 3], prerelease: [] } },
      buildId: BUILD_ID,
    });
    expect(decodeBuildMetadata(JSON.stringify({ version: "2.0.0-rc.1", buildId: "sha512-0f3c" }))).toEqual({
      version: { canonical: "2.0.0-rc.1", precedence: { core: [2, 0, 0], prerelease: ["rc", 1] } },
      buildId: "sha512-0f3c",
    });
  });

  test("a version or build identity that cannot be one directory name is refused", () => {
    for (const overrides of [
      { version: "../1.2.3" },
      { version: "1.2.3/4" },
      { version: "" },
      { buildId: "../../etc" },
      { buildId: "a/b" },
      { buildId: "a\\b" },
      { buildId: "" },
      { buildId: ".hidden" },
      { buildId: `${"a".repeat(63)}.` },
    ]) {
      expect(() => decodeBuildMetadata(metadata(overrides))).toThrow(BuildIdentityError);
    }
  });

  test("text that is not build metadata is refused", () => {
    expect(() => decodeBuildMetadata("not json")).toThrow(BuildIdentityError);
    expect(() => decodeBuildMetadata(JSON.stringify({ version: "1.2.3" }))).toThrow(BuildIdentityError);
  });
});

describe("immutable install target", () => {
  test("the physical target is derived from the account root, version, and build", () => {
    const identity = decodeBuildMetadata(metadata());
    expect(buildInstallDir("/account/.flywheel", identity)).toBe(path.join("/account/.flywheel", "versions", "1.2.3", BUILD_ID));
  });

  test("one account-global link names the build the next launch runs", () => {
    expect(currentBuildLink("/account/.flywheel")).toBe(path.join("/account/.flywheel", "current"));
    expect(buildInstallDir("/account/.flywheel", decodeBuildMetadata(metadata())).startsWith(`${versionsDir("/account/.flywheel")}${path.sep}`)).toBe(true);
  });

  test("a build directory whose metadata names another version or build is refused", () => {
    const identity = decodeBuildMetadata(metadata());
    const target = buildInstallDir("/account/.flywheel", identity);

    expect(() => assertInstallLocation(identity, target)).not.toThrow();
    expect(() => assertInstallLocation(identity, path.join("/account/.flywheel", "versions", "1.2.4", BUILD_ID))).toThrow(BuildIdentityError);
    expect(() => assertInstallLocation(identity, path.join("/account/.flywheel", "versions", "1.2.3", "b".repeat(64)))).toThrow(BuildIdentityError);
  });
});

describe("the version an executable reports", () => {
  test("an installed build names the build its metadata states", () => {
    const root = tree({ "flywheel-bin": "binary bytes", [BUILD_METADATA_FILE]: metadata() });

    expect(versionLine("1.2.3", buildIdentityBeside(path.join(root, "flywheel-bin"))?.buildId)).toBe(`flywheel 1.2.3 (build ${BUILD_ID})`);
  });

  test("an executable with no usable metadata beside it names only its version", () => {
    const bare = tree({ "flywheel-bin": "binary bytes" });
    const unusable = tree({ "flywheel-bin": "binary bytes", [BUILD_METADATA_FILE]: metadata({ buildId: "../not a directory" }) });

    expect(versionLine("1.2.3", buildIdentityBeside(path.join(bare, "flywheel-bin"))?.buildId)).toBe("flywheel 1.2.3");
    expect(buildIdentityBeside(path.join(unusable, "flywheel-bin"))).toBeUndefined();
  });
});

describe("build identity digest", () => {
  test("two byte-identical trees produce one build identity", () => {
    expect(computeBuildId(tree(PAYLOAD), process.platform)).toBe(computeBuildId(tree(PAYLOAD), process.platform));
  });

  test("the recorded metadata file is not part of the identity it names", () => {
    const plain = computeBuildId(tree(PAYLOAD), process.platform);
    const described = computeBuildId(tree({ ...PAYLOAD, [BUILD_METADATA_FILE]: metadata() }), process.platform);
    expect(described).toBe(plain);
  });

  test("changed bytes, a changed path, a changed executable mode, or an added empty directory each change the identity", () => {
    const base = computeBuildId(tree(PAYLOAD), process.platform);

    const { "flywheel-bin": binary, ...withoutBinary } = PAYLOAD;
    expect(computeBuildId(tree({ ...PAYLOAD, "flywheel-bin": "other bytes" }), process.platform)).not.toBe(base);
    expect(computeBuildId(tree({ ...withoutBinary, "flywheel-binary": binary }), process.platform)).not.toBe(base);
    // The executable bit is part of the identity only where the filesystem keeps
    // one: Windows reports the same mode however the tree was written.
    if (POSIX_FILE_MODES) expect(computeBuildId(tree(PAYLOAD, { "flywheel-bin": 0o755 }), process.platform)).not.toBe(base);
    expect(computeBuildId(tree({ ...PAYLOAD, "native/linux-x64": null }), process.platform)).not.toBe(base);
  });

  // A Windows archive is built on a Mac, where the compiled executable carries
  // an execute bit, and proved again on Windows, which reports none.
  test("a Windows build's identity does not depend on the execute bit of the host that digests it", () => {
    const plain = computeBuildId(tree(PAYLOAD), "win32");
    const marked = computeBuildId(tree(PAYLOAD, { "flywheel-bin": 0o755 }), "win32");

    expect(marked).toBe(plain);
    expect(computeBuildId(tree({ ...PAYLOAD, "flywheel-bin": "other bytes" }), "win32")).not.toBe(plain);
  });

  test("a tree that holds anything but regular files and directories has no build identity", () => {
    const root = tree(PAYLOAD);
    fs.symlinkSync("flywheel-bin", path.join(root, "flywheel"));

    expect(() => computeBuildId(root, process.platform)).toThrow(BuildIdentityError);
  });
});
