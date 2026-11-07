/** The release pipeline is the publisher's trust root (ADR-014): whatever
 *  `bun run release` publishes is what every installed client trusts and
 *  auto-installs. These tests hold the publication invariants the retired
 *  release workflow used to enforce structurally: the asset set is exact, and
 *  `latest` only ever moves forward. The gh-driven choreography (draft,
 *  verify, publish, delete-on-failure) lives in `scripts/release-publish.ts`
 *  beside these checks. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RELEASE_ASSETS, RELEASE_BUILD_COMMANDS } from "../../../scripts/release-contract.js";
import { assetSetViolation, movesLatestForward } from "../../../scripts/release-publish.js";

const PUBLISH_DOC_PATH = join(import.meta.dir, "..", "..", "..", "PUBLISH.md");
const publishDoc = readFileSync(PUBLISH_DOC_PATH, "utf-8");
describe("the publishable asset set", () => {
  test("is exactly the five archives, the manifest, the digest file, and the two installers", () => {
    expect([...RELEASE_ASSETS].sort()).toEqual([
      "SHASUMS256.txt",
      "flywheel-darwin-arm64.tar.gz",
      "flywheel-linux-arm64.tar.gz",
      "flywheel-linux-x64.tar.gz",
      "flywheel-win32-arm64.tar.gz",
      "flywheel-win32-x64.tar.gz",
      "install.ps1",
      "install.sh",
      "release.json",
    ]);
  });

  test("accepts the exact set in any order", () => {
    expect(assetSetViolation(RELEASE_ASSETS.toReversed())).toBeUndefined();
  });

  test("refuses a missing asset", () => {
    expect(assetSetViolation(RELEASE_ASSETS.filter((name) => name !== "release.json"))).toContain("not the five archives");
  });

  test("refuses an extra asset", () => {
    expect(assetSetViolation([...RELEASE_ASSETS, "perf-evidence.zip"])).toContain("not the five archives");
  });

  test("refuses a duplicated asset", () => {
    expect(assetSetViolation([...RELEASE_ASSETS, "release.json"])).toContain("not the five archives");
  });

  test("refuses an empty upload", () => {
    expect(assetSetViolation([])).toContain("not the five archives");
  });
});

describe("release archive assembly", () => {
  test("builds every canonical target from repository-owned native source", () => {
    expect(RELEASE_BUILD_COMMANDS).toEqual([
      ["bun", "run", "scripts/build-binary.ts", "--target=bun-darwin-arm64", "--native-provenance=source-build"],
      ["bun", "run", "scripts/build-binary.ts", "--target=bun-linux-arm64", "--native-provenance=source-build"],
      ["bun", "run", "scripts/build-binary.ts", "--target=bun-linux-x64", "--native-provenance=source-build"],
      ["bun", "run", "scripts/build-binary.ts", "--target=bun-windows-arm64", "--native-provenance=source-build"],
      ["bun", "run", "scripts/build-binary.ts", "--target=bun-windows-x64", "--native-provenance=source-build"],
    ]);
  });
});

describe("the authority that moves latest", () => {
  test("moves forward only", () => {
    expect(movesLatestForward("v0.0.3", "v0.0.2")).toBe(true);
    expect(movesLatestForward("v0.1.0", "v0.0.9")).toBe(true);
    expect(movesLatestForward("v1.0.0", "v0.9.9")).toBe(true);
  });

  test("refuses an equal version", () => {
    expect(movesLatestForward("v0.0.2", "v0.0.2")).toBe(false);
  });

  test("refuses an older version", () => {
    expect(movesLatestForward("v0.0.1", "v0.0.2")).toBe(false);
  });

  test("refuses versions that are not strict semver", () => {
    expect(movesLatestForward("v0.0.3-rc1", "v0.0.2")).toBe(false);
    expect(movesLatestForward("v0.0.3", "latest")).toBe(false);
  });
});

/** Moving what GitHub serves as `latest` is the one mutation this repository
 *  cannot take back, so it has one authority: `scripts/release-publish.ts`,
 *  reached through `bun run release` for a forward publication and
 *  `bun run release --rollback` for a rollback. GitHub offers no
 *  compare-and-set on `latest`, so the contract is instead that no other path
 *  is supported: an out-of-band `gh release edit` that moves `latest` is not
 *  part of it. Editing a release's notes body is the one supported
 *  out-of-band mutation, because no client reads the body. */
describe("the publication document", () => {
  test("names the release command as the publication authority", () => {
    expect(publishDoc).toContain("bun run release");
    expect(publishDoc).toContain("only supported authority that moves what GitHub serves as `latest`");
  });

  test("documents the rollback through the release command, never a raw latest edit", () => {
    expect(publishDoc).toContain("bun run release --rollback");
    // Command lines only: prose may name `gh release edit` while forbidding it.
    const edits = publishDoc.split("\n").filter((line) => line.startsWith("gh release edit"));
    expect(edits.length).toBeGreaterThan(0);
    for (const line of edits) {
      expect(line).toContain("--notes-file");
      expect(line).not.toContain("--latest");
    }
  });
});
