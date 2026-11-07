/** A release names exactly one version, and a normal publish only ever moves
 *  forward. So the gate refuses a tag that does not state the version
 *  `package.json` states, and refuses a candidate that is not strictly newer
 *  than the one release the repository now serves as `latest`. That release is
 *  the only authority the gate holds: a Git tag that names no release orders
 *  nothing, and an operator who marks an older release latest has moved the
 *  line. Going backwards is a rollback, which this path never performs. */

import { describe, expect, test } from "bun:test";
import { validateReleaseVersion } from "../../../scripts/release-version-gate.js";

function validate(tag: string, packageVersion: string, latestReleaseTag: string): string {
  return validateReleaseVersion({ tag, packageVersion, latestReleaseTag });
}

describe("the release version gate", () => {
  test("returns the version the tag and package.json both state", () => {
    expect(validate("v1.4.3", "1.4.3", "v1.4.2")).toBe("1.4.3");
  });

  test("refuses a tag that does not state the package version", () => {
    expect(() => validate("v1.5.0", "1.4.3", "v1.4.2")).toThrow(/v1.5.0 is not v1.4.3/);
  });

  test("refuses a package version that names no strict release", () => {
    expect(() => validate("v1.5.0-rc.1", "1.5.0-rc.1", "v1.4.2")).toThrow(/not a strict major\.minor\.patch release/);
  });

  test("refuses a candidate older than the release now served as latest", () => {
    expect(() => validate("v1.4.0", "1.4.0", "v1.4.2")).toThrow(/v1\.4\.0 is not newer than v1\.4\.2/);
  });

  test("refuses a candidate equal to the release now served as latest", () => {
    expect(() => validate("v1.4.2", "1.4.2", "1.4.2")).toThrow(/not newer than 1\.4\.2/);
  });

  test("compares by version order, not by tag order", () => {
    expect(() => validate("v1.9.9", "1.9.9", "v10.0.0")).toThrow(/not newer than v10\.0\.0/);
  });

  // A tag is not a release. `v2.0.0` can sit in the repository as a tag whose
  // publish never finished, and the gate never sees it: it takes one latest
  // release tag, so that unpublished tag stops no publish of `v1.4.3`.
  test("takes only the latest release tag, so a higher unpublished tag blocks nothing", () => {
    expect(validate("v1.4.3", "1.4.3", "v1.4.2")).toBe("1.4.3");
  });

  // An operator who serves an older release as latest, to stop a bad one, has
  // moved the line the next publish must clear. That choice is the authority.
  test("takes an operator-selected older latest as the line to clear", () => {
    expect(validate("v1.3.0", "1.3.0", "v1.2.0")).toBe("1.3.0");
    expect(() => validate("v1.2.0", "1.2.0", "v1.2.0")).toThrow(/not newer than v1\.2\.0/);
  });

  test("refuses a latest release that states no strict release, because nothing orders against it", () => {
    expect(() => validate("v1.4.3", "1.4.3", "nightly")).toThrow(/nightly states no strict major\.minor\.patch release/);
  });

  test("publishes the first release when the repository serves no latest release", () => {
    expect(validate("v0.1.0", "0.1.0", "")).toBe("0.1.0");
  });
});
