import { describe, expect, it } from "bun:test";

import { patchOpenTuiNativePackageImport } from "../../../scripts/opentui-native-package-patch.js";

const interpolation = (name: string) => ["", `{${name}}`].join("$");

describe("OpenTUI native package import patch", () => {
  it("rewrites the old template-literal import shape", () => {
    const source = `const nativePackage = await import(\`@opentui/core-${interpolation("process.platform")}-${interpolation("process.arch")}\`);`;

    const patched = patchOpenTuiNativePackageImport(source, "darwin-arm64");

    expect(patched).toBe('const nativePackage = await import("@opentui/core-darwin-arm64");');
  });

  it("collapses the generated resolver to the target native package", () => {
    const source = [
      "async function resolveNativePackage() {",
      '  if (process.platform === "darwin") {',
      '    if (process.arch === "arm64")',
      '      return await import("@opentui/core-darwin-arm64");',
      "  }",
      '  if (process.platform === "linux") {',
      "    validateLinuxLibcOverride();",
      '    if (process.arch === "x64") {',
      '      if (process.env.OPENTUI_LIBC === "musl") {',
      '        return await import("@opentui/core-linux-x64-musl");',
      "      } else {",
      '        return await import("@opentui/core-linux-x64");',
      "      }",
      "    }",
      "  }",
      `  throw new Error(\`opentui is not supported on the current platform: ${interpolation("process.platform")}-${interpolation("process.arch")}\`);`,
      "}",
      "var nativePackage = await resolveNativePackage();",
      "var targetLibPath = nativePackage.default;",
    ].join("\n");

    const patched = patchOpenTuiNativePackageImport(source, "linux-x64");

    expect(patched).toContain('return await import("@opentui/core-linux-x64");');
    expect(patched).not.toContain("@opentui/core-linux-x64-musl");
    expect(patched).toContain("var targetLibPath = nativePackage.default;");
  });

  it("collapses the 0.5.x library-path resolver to the target native package", () => {
    const source = [
      "async function resolveNativeLibraryPath() {",
      "  const asset = getNativeAssetDescriptor(getCurrentNodeAssetTarget());",
      "  const configuredPath = resolveAssetRootPath(asset.key);",
      "  if (configuredPath !== undefined) {",
      "    return configuredPath;",
      "  }",
      '  if (process.platform === "darwin") {',
      '    if (process.arch === "arm64") {',
      '      return (await import("@opentui/core-darwin-arm64")).default;',
      "    }",
      "  }",
      `  throw new Error(\`OpenTUI is not supported on the current platform: ${interpolation("asset.packageName")}\`);`,
      "}",
      "var nativeLibraryPath = await resolveNativeLibraryPath();",
    ].join("\n");

    const patched = patchOpenTuiNativePackageImport(source, "linux-arm64");

    expect(patched).toContain('return (await import("@opentui/core-linux-arm64")).default;');
    expect(patched).not.toContain("@opentui/core-darwin-arm64");
    expect(patched).toContain("var nativeLibraryPath = await resolveNativeLibraryPath();");
  });

  it("returns undefined for unrecognized bundle shapes", () => {
    expect(patchOpenTuiNativePackageImport("const targetLibPath = nativePackage.default;", "darwin-arm64"))
      .toBeUndefined();
  });
});
