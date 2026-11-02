/** The release pipeline is the publisher's trust root (ARCH-DISTRIBUTION-007): whatever
 *  `bun run release` publishes is what every installed client trusts and
 *  auto-installs. These tests hold the publication invariants the retired
 *  release workflow used to enforce structurally: the asset set is exact, and
 *  `latest` only ever moves forward. The gh-driven choreography (draft,
 *  verify, publish, delete-on-failure) lives in `scripts/release-publish.ts`
 *  beside these checks. */

import { describe, expect, test } from "bun:test";

import { OFFICIAL_RELEASE_REPOSITORY, officialReleaseRefusal, RELEASE_ASSETS, releaseBuildInputs, releaseReportEndpoint } from "../../../scripts/release-contract.js";
import { assetSetViolation, movesLatestForward } from "../../../scripts/release-publish.js";

describe("the publishable asset set", () => {
  test("accepts the exact set in any order", () => {
    expect(assetSetViolation(RELEASE_ASSETS.toReversed())).toBeUndefined();
  });

  test("refuses a missing asset", () => {
    expect(assetSetViolation(RELEASE_ASSETS.filter((name) => name !== "release.json"))).toContain("not the archive of every target");
  });

  test("refuses an extra asset", () => {
    expect(assetSetViolation([...RELEASE_ASSETS, "perf-evidence.zip"])).toContain("not the archive of every target");
  });

  test("refuses a duplicated asset", () => {
    expect(assetSetViolation([...RELEASE_ASSETS, "release.json"])).toContain("not the archive of every target");
  });

  test("refuses an empty upload", () => {
    expect(assetSetViolation([])).toContain("not the archive of every target");
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

describe("the report endpoint a release build compiles in", () => {
  test("comes only from the release machine's environment", () => {
    expect(releaseReportEndpoint({})).toBeUndefined();
    expect(releaseReportEndpoint({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: " " })).toBeUndefined();
    expect(releaseReportEndpoint({ FLYWHEEL_REPORT_ENDPOINT: "https://reports.example/reports" })).toBeUndefined();
    expect(releaseReportEndpoint({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: "https://reports.example/reports" })).toBe("https://reports.example/reports");
  });

  test("refuses a value that is not an https URL", () => {
    expect(() => releaseReportEndpoint({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: "http://reports.example/reports" })).toThrow("must be an https URL");
    expect(() => releaseReportEndpoint({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: "relay.flywl.sh/reports" })).toThrow("must be an https URL");
  });
});

describe("the publisher inputs a release build compiles in", () => {
  const endpoint = "https://reports.example/reports";

  test("an official release updates from the official repository and must carry the report endpoint", () => {
    expect(releaseBuildInputs({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: endpoint })).toEqual({ updateRepository: OFFICIAL_RELEASE_REPOSITORY, reportEndpoint: endpoint });
    expect(officialReleaseRefusal({ FLYWHEEL_RELEASE_REPORT_ENDPOINT: endpoint })).toBeUndefined();
    expect(officialReleaseRefusal({})).toContain("FLYWHEEL_RELEASE_REPORT_ENDPOINT");
    expect(officialReleaseRefusal({ PUBLIC_REPO: " " })).toContain("FLYWHEEL_RELEASE_REPORT_ENDPOINT");
  });

  test("a fork's release updates from its own repository and needs no report endpoint", () => {
    expect(releaseBuildInputs({ PUBLIC_REPO: "someone/fork" })).toEqual({ updateRepository: "someone/fork", reportEndpoint: undefined });
    expect(officialReleaseRefusal({ PUBLIC_REPO: "someone/fork" })).toBeUndefined();
  });
});
