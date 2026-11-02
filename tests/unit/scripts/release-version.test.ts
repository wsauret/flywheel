import { describe, expect, test } from "bun:test";
import { compareSemanticVersions, parseSemanticVersion } from "../../../scripts/release-version.js";

/** The canonical form of a version this parser accepts. */
function canonical(input: string): string | undefined {
  return parseSemanticVersion(input)?.canonical;
}

describe("release version parsing", () => {
  test("a canonical version keeps its three numeric fields", () => {
    expect(parseSemanticVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, canonical: "1.2.3" });
  });

  test("build metadata names the same version and never reaches an install path", () => {
    expect(canonical("1.2.3+darwin.arm64")).toBe("1.2.3");
    expect(canonical("v1.2.3+build.7")).toBe("1.2.3");
  });

  test("a prerelease is refused", () => {
    for (const input of ["1.2.3-rc.1", "v1.2.3-alpha", "1.2.3-0", "1.2.3-rc.1+build"]) {
      expect(parseSemanticVersion(input)).toBeUndefined();
    }
  });

  test("malformed input is refused", () => {
    for (const input of ["", "v", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03", " 1.2.3", "1.2.3 ", "1.2.3+", "1.2.3++a", "+1.2.3", "1.2.-3", "one.two.three", "1.2.3\n", "1.2.3/../4"]) {
      expect(parseSemanticVersion(input)).toBeUndefined();
    }
  });
});

describe("release version ordering", () => {
  test("major outranks minor and minor outranks patch", () => {
    const order = ["0.0.9", "0.1.0", "0.10.0", "1.0.0", "2.0.0"].map((value) => {
      const parsed = parseSemanticVersion(value);
      if (!parsed) throw new Error(`${value} parses`);
      return parsed;
    });
    const shuffled = [3, 0, 4, 2, 1].flatMap((index) => order.slice(index, index + 1));
    expect([...shuffled].sort(compareSemanticVersions).map((version) => version.canonical)).toEqual(order.map((version) => version.canonical));
  });

  test("a leading v and build metadata are ignored for ordering", () => {
    const plain = parseSemanticVersion("1.2.3");
    const decorated = parseSemanticVersion("v1.2.3+build.9");
    if (!plain || !decorated) throw new Error("both versions parse");
    expect(compareSemanticVersions(plain, decorated)).toBe(0);
  });
});
