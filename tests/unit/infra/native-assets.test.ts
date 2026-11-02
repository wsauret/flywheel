import { afterEach, describe, expect, test } from "bun:test";

import { buildPlatformArch, hostLibcSuffix, libcSuffix } from "../../../src/infra/native-assets.js";

const override = process.env.FLYWHEEL_PLATFORM_ARCH;

afterEach(() => {
  if (override === undefined) delete process.env.FLYWHEEL_PLATFORM_ARCH;
  else process.env.FLYWHEEL_PLATFORM_ARCH = override;
});

describe("the C library that a source run names in its target", () => {
  test("is musl on a Linux whose runtime states no glibc version, and nothing on a glibc Linux", () => {
    expect(libcSuffix("linux", () => ({ header: { glibcVersionRuntime: "2.41" } }))).toBe("");
    expect(libcSuffix("linux", () => ({ header: { osName: "Linux" } }))).toBe("-musl");
    expect(libcSuffix("linux", () => ({ header: { glibcVersionRuntime: undefined } }))).toBe("-musl");
  });

  test("is nothing on macOS and Windows, which have no musl build, so their runtime report is never read", () => {
    const unread = (): object => {
      throw new Error("the report was read");
    };
    expect(libcSuffix("darwin", unread)).toBe("");
    expect(libcSuffix("win32", unread)).toBe("");
  });

  test("gives way to the target that FLYWHEEL_PLATFORM_ARCH states", () => {
    process.env.FLYWHEEL_PLATFORM_ARCH = "linux-arm64-musl";
    expect(buildPlatformArch()).toBe("linux-arm64-musl");
    delete process.env.FLYWHEEL_PLATFORM_ARCH;
    expect(buildPlatformArch()).toBe(`${process.platform}-${process.arch}${hostLibcSuffix()}`);
  });
});
