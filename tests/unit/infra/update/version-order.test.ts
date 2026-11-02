import { describe, expect, test } from "bun:test";
import { compareReleaseVersions, isLaterRelease, parseReleaseVersion, type ReleaseVersion } from "../../../../src/infra/update/version-order.js";

describe("a release version as an installed client reads it", () => {
  function read(input: string): ReleaseVersion {
    const parsed = parseReleaseVersion(input);
    if (!parsed) throw new Error(`${input} reads as a release version`);
    return parsed;
  }

  test("a prerelease, build metadata, and a version that is not SemVer all read", () => {
    expect(read("1.2.3-rc.1").canonical).toBe("1.2.3-rc.1");
    expect(read("v1.2.3+build.7").canonical).toBe("1.2.3");
    expect(read("2027.1").canonical).toBe("2027.1");
    expect(read("2027.1").precedence).toBeUndefined();
  });

  test("only a version that cannot be one directory name on every platform is refused", () => {
    for (const input of ["", ".", "..", ".hidden", "1.2/../3", "1.2\\3", "1.2.3\n", "1\u00002"]) {
      expect(parseReleaseVersion(input)).toBeUndefined();
    }
    // Windows refuses these characters in a name, and opens a device for
    // these names whatever extension follows them.
    for (const input of ["1:2", "1*2", "1?2", "1\"2", "1<2", "1>2", "1|2", "CON", "nul", "Aux.1", "com1", "COM9.txt", "lpt\u00b9", "LPT3.0.0", "prn.1.2.3"]) {
      expect(parseReleaseVersion(input)).toBeUndefined();
    }
    // A name that only begins like a device is an ordinary name.
    for (const input of ["console", "nullable", "com10", "lpt", "1.0.0-con"]) {
      expect(parseReleaseVersion(input)?.canonical).toBe(input);
    }
  });

  test("SemVer precedence orders prereleases below their release", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareReleaseVersions(read(ordered[index - 1] ?? ""), read(ordered[index] ?? ""))).toBeLessThan(0);
      expect(isLaterRelease(read(ordered[index] ?? ""), read(ordered[index - 1] ?? ""))).toBe(true);
      expect(isLaterRelease(read(ordered[index - 1] ?? ""), read(ordered[index] ?? ""))).toBe(false);
    }
  });

  test("a version the client cannot order is a later release unless it is the same one", () => {
    expect(compareReleaseVersions(read("2027.1"), read("0.1.0"))).toBeUndefined();
    expect(isLaterRelease(read("2027.1"), read("0.1.0"))).toBe(true);
    expect(isLaterRelease(read("2027.1"), read("2027.1"))).toBe(false);
  });

  test("an older or equal SemVer release is never later, so a rolled-back channel moves no client back", () => {
    expect(isLaterRelease(read("0.0.12"), read("0.1.0"))).toBe(false);
    expect(isLaterRelease(read("v0.1.0+meta"), read("0.1.0"))).toBe(false);
  });
});
