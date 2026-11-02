import { readFile } from "node:fs/promises";
import { join } from "node:path";

const interpolation = (name: string) => ["", `{${name}}`].join("$");
const processPlatform = interpolation("process.platform");
const processArch = interpolation("process.arch");
const dynamicNativePackageImport = `await import(\`@opentui/core-${processPlatform}-${processArch}\`)`;

const resolveNativePackagePattern =
  /async function resolveNativePackage\(\) \{[\s\S]*?\n\}\nvar nativePackage = await resolveNativePackage\(\);/;

// The 0.5.x resolver: a per-platform switch of static imports, closed by the
// first brace at column zero (every inner close is indented).
const resolveNativeLibraryPathPattern =
  /async function resolveNativeLibraryPath\(\) \{[\s\S]*?\n\}/;

export function patchOpenTuiNativePackageImport(source: string, platformArch: string): string | undefined {
  const staticImport = `await import("@opentui/core-${platformArch}")`;
  if (source.includes(dynamicNativePackageImport)) {
    return source.replaceAll(dynamicNativePackageImport, staticImport);
  }

  const libraryPathMatch = source.match(resolveNativeLibraryPathPattern);
  if (libraryPathMatch?.[0].includes("@opentui/core-")) {
    const staticLibraryResolver = [
      "async function resolveNativeLibraryPath() {",
      `  return (${staticImport}).default;`,
      "}",
    ].join("\n");
    return source.replace(resolveNativeLibraryPathPattern, staticLibraryResolver);
  }

  const match = source.match(resolveNativePackagePattern);
  if (!match?.[0].includes("@opentui/core-")) return undefined;

  const staticResolver = [
    "async function resolveNativePackage() {",
    `  return ${staticImport};`,
    "}",
    "var nativePackage = await resolveNativePackage();",
  ].join("\n");

  return source.replace(resolveNativePackagePattern, staticResolver);
}

export async function patchOpenTuiNativePackageImportFiles(root: string, platformArch: string): Promise<Map<string, string>> {
  const originals = new Map<string, string>();
  const opentuiBundleGlob = new Bun.Glob("node_modules/@opentui/core/*.js");

  for await (const rel of opentuiBundleGlob.scan({ cwd: root, onlyFiles: true })) {
    const abs = join(root, rel);
    const source = await readFile(abs, "utf-8");
    const patched = patchOpenTuiNativePackageImport(source, platformArch);
    if (!patched) continue;
    originals.set(abs, source);
    await Bun.write(abs, patched);
  }

  if (originals.size === 0) {
    throw new Error("Could not locate a supported OpenTUI native-package import shape.");
  }

  return originals;
}

export async function restorePatchedFiles(originals: ReadonlyMap<string, string>): Promise<void> {
  for (const [abs, source] of originals) await Bun.write(abs, source);
}
