import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "jsonc-parser";

import { isRecord } from "../src/infra/record.js";
import { cargoLicenseLedgerIsCurrent } from "./cargo-license-ledger.js";
import type { ReviewedRuntimeComponent } from "./review-bun-runtime-licenses.js";

const SHIPPING_WORKSPACES = ["", "webview", "relay", "vscode"] as const;
const SHIPPED_OPTIONAL_PACKAGE = /^(?:@img\/sharp-|@img\/sharp-libvips-|@opentui\/core-|@msgpackr-extract\/|@anthropic-ai\/claude-agent-sdk-)/u;
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*|$)|third[-_ ]party.*(?:notice|licen[cs]e)/iu;
const OUTPUT = "THIRD-PARTY-LICENSES.txt";

interface LockedPackage {
  readonly key: string;
  readonly identity: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly string[];
  readonly optionalDependencies: readonly string[];
}

interface ReviewedSource {
  readonly source: string;
  readonly files: readonly string[];
  readonly evidence?: readonly string[];
}

interface LegalDocument {
  readonly name: string;
  readonly text: string;
}

interface ProductionNpmGraph {
  readonly packages: Map<string, LockedPackage>;
  readonly keys: Set<string>;
}

function stringKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    result.push(item);
  }
  return result;
}

function lockPackages(value: unknown): Map<string, LockedPackage> {
  if (!isRecord(value) || !isRecord(value["packages"])) throw new Error("bun.lock has no packages table");
  const result = new Map<string, LockedPackage>();
  for (const [key, row] of Object.entries(value["packages"])) {
    if (!Array.isArray(row) || typeof row[0] !== "string") throw new Error(`bun.lock package ${key} is malformed`);
    const identity = row[0];
    const at = identity.lastIndexOf("@");
    if (at <= 0) throw new Error(`bun.lock package identity is malformed: ${identity}`);
    const metadata = row[2];
    result.set(key, {
      key,
      identity,
      name: identity.slice(0, at),
      version: identity.slice(at + 1),
      dependencies: isRecord(metadata) ? stringKeys(metadata["dependencies"]) : [],
      optionalDependencies: isRecord(metadata) ? stringKeys(metadata["optionalDependencies"]) : [],
    });
  }
  return result;
}

function resolveDependency(packages: ReadonlyMap<string, LockedPackage>, parentKey: string, dependency: string): string {
  let prefix = parentKey;
  while (prefix.length > 0) {
    const nested = `${prefix}/${dependency}`;
    if (packages.has(nested)) return nested;
    const slash = prefix.lastIndexOf("/");
    prefix = slash < 0 ? "" : prefix.slice(0, slash);
  }
  if (packages.has(dependency)) return dependency;
  throw new Error(`bun.lock cannot resolve ${dependency} from ${parentKey || "workspace root"}`);
}

function productionNpmPackageKeys(lock: unknown): ProductionNpmGraph {
  if (!isRecord(lock) || !isRecord(lock["workspaces"])) throw new Error("bun.lock has no workspaces table");
  const packages = lockPackages(lock);
  const queue: string[] = [];
  for (const workspace of SHIPPING_WORKSPACES) {
    const row = lock["workspaces"][workspace];
    if (!isRecord(row)) throw new Error(`bun.lock is missing shipping workspace ${workspace || "."}`);
    const parentKey = workspace === ""
      ? ""
      : typeof row["name"] === "string"
        ? row["name"]
        : (() => { throw new Error(`bun.lock shipping workspace ${workspace} has no name`); })();
    for (const dependency of stringKeys(row["dependencies"])) queue.push(resolveDependency(packages, parentKey, dependency));
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || visited.has(key)) continue;
    visited.add(key);
    const pkg = packages.get(key);
    if (pkg === undefined) throw new Error(`bun.lock package disappeared: ${key}`);
    for (const dependency of pkg.dependencies) queue.push(resolveDependency(packages, key, dependency));
    for (const dependency of pkg.optionalDependencies) {
      if (SHIPPED_OPTIONAL_PACKAGE.test(dependency)) queue.push(resolveDependency(packages, key, dependency));
    }
  }
  return { packages, keys: visited };
}

/** Returns exact package identities reachable from shipping workspaces in one parsed Bun lockfile. */
export function productionNpmPackagesFromLock(lock: unknown): Set<string> {
  const { packages, keys } = productionNpmPackageKeys(lock);
  return new Set([...keys].map((key) => packages.get(key)?.identity).filter((identity): identity is string => identity !== undefined));
}

/** Returns exact package identities reachable from shipping workspace production roots. */
export async function productionNpmPackages(root: string): Promise<Set<string>> {
  const lock: unknown = parse(await readFile(join(root, "bun.lock"), "utf8"));
  return productionNpmPackagesFromLock(lock);
}

function packageTokens(key: string): string[] {
  const segments = key.split("/");
  const tokens: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment?.startsWith("@")) {
      const name = segments[index + 1];
      if (name === undefined) throw new Error(`invalid scoped bun.lock key: ${key}`);
      tokens.push(`${segment}/${name}`);
      index += 1;
    } else if (segment !== undefined) tokens.push(segment);
  }
  return tokens;
}

function manifestVersion(directory: string): string | undefined {
  if (!existsSync(join(directory, "package.json"))) return undefined;
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return isRecord(manifest) && typeof manifest["version"] === "string" ? manifest["version"] : undefined;
  } catch {
    return undefined;
  }
}

/** Every installed package directory under the shipping workspaces, keyed by `name@version`. Bun's hoisted linker
 *  does not always install a package at its bun.lock key path: when most dependents want another version, it hoists
 *  that one and nests the locked one under a dependent. Every copy of one version holds the same legal files. */
function installedPackageDirectories(root: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const visit = (modules: string): void => {
    if (!existsSync(modules)) return;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const names = entry.name.startsWith("@")
        ? readdirSync(join(modules, entry.name), { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => `${entry.name}/${child.name}`)
        : [entry.name];
      for (const name of names) {
        const directory = join(modules, name);
        const version = manifestVersion(directory);
        if (version !== undefined && !found.has(`${name}@${version}`)) found.set(`${name}@${version}`, directory);
        visit(join(directory, "node_modules"));
      }
    }
  };
  for (const workspace of SHIPPING_WORKSPACES) visit(join(root, workspace, "node_modules"));
  return found;
}

function packageDirectory(root: string, pkg: LockedPackage, installed: () => ReadonlyMap<string, string>): string | undefined {
  let nested = root;
  for (const token of packageTokens(pkg.key)) nested = join(nested, "node_modules", ...token.split("/"));
  return [nested, join(root, "node_modules", ...pkg.name.split("/"))].find((candidate) => manifestVersion(candidate) === pkg.version)
    ?? installed().get(`${pkg.name}@${pkg.version}`);
}

async function legalDocuments(directory: string, relativeFiles?: readonly string[]): Promise<LegalDocument[]> {
  const names = relativeFiles === undefined
    ? (await readdir(directory)).filter((name) => LEGAL_FILE.test(name)).sort()
    : [...relativeFiles];
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(directory, name), "utf8") })));
}

async function reviewedSources(root: string): Promise<ReadonlyMap<string, ReviewedSource>> {
  const parsed: unknown = JSON.parse(await readFile(join(root, "third-party", "reviewed", "sources.json"), "utf8"));
  if (!isRecord(parsed)) throw new Error("third-party/reviewed/sources.json must be an object");
  const result = new Map<string, ReviewedSource>();
  for (const [identity, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value["source"] !== "string") {
      throw new Error(`reviewed legal source ${identity} is malformed`);
    }
    const files = stringArray(value["files"]);
    if (files === undefined) throw new Error(`reviewed legal source ${identity} is malformed`);
    const evidence = value["evidence"] === undefined ? undefined : stringArray(value["evidence"]);
    if (value["evidence"] !== undefined && evidence === undefined) {
      throw new Error(`reviewed legal source evidence ${identity} is malformed`);
    }
    const source: ReviewedSource = { source: value["source"], files, ...(evidence === undefined ? {} : { evidence }) };
    for (const file of [...source.files, ...(source.evidence ?? [])]) {
      if (!existsSync(join(root, file))) throw new Error(`reviewed legal source ${identity} is missing ${file}`);
    }
    result.set(identity, source);
  }
  return result;
}

function nativeFamilySource(root: string, pkg: LockedPackage): ReviewedSource | undefined {
  // Each archive ships one platform package's Claude engine. Every platform package carries the SDK's own
  // LICENSE.md byte for byte, so the installed SDK of the same version is the legal source of each of them.
  if (pkg.name.startsWith("@anthropic-ai/claude-agent-sdk-")) {
    const owner = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const manifest: unknown = JSON.parse(readFileSync(join(owner, "package.json"), "utf8"));
    if (!isRecord(manifest) || manifest["version"] !== pkg.version) throw new Error(`@anthropic-ai/claude-agent-sdk@${pkg.version} is required as the engine family legal authority`);
    return { source: `published package @anthropic-ai/claude-agent-sdk@${pkg.version}`, files: ["node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md"] };
  }
  if (pkg.name.startsWith("@img/sharp-libvips-") && pkg.version === "1.3.4") {
    return {
      source: "https://github.com/lovell/sharp-libvips/tree/v1.3.4",
      files: [
        "third-party/reviewed/npm/sharp-libvips-1.3.4/LICENSING.md",
        "third-party/licenses/GPL-3.0.txt",
        "third-party/licenses/LGPL-3.0.txt",
      ],
    };
  }
  if (pkg.name.startsWith("@img/sharp-") && pkg.version === "0.35.5") {
    const owner = join(root, "node_modules", "sharp");
    const manifest: unknown = JSON.parse(readFileSync(join(owner, "package.json"), "utf8"));
    if (!isRecord(manifest) || manifest["version"] !== "0.35.5") throw new Error("sharp@0.35.5 is required as the native family legal authority");
    return { source: "https://github.com/lovell/sharp/tree/v0.35.5", files: ["node_modules/sharp/LICENSE"] };
  }
  if (pkg.name.startsWith("@msgpackr-extract/") && pkg.version === "3.0.4") {
    return {
      source: "https://github.com/kriszyp/msgpackr-extract/tree/v3.0.4",
      files: ["third-party/reviewed/npm/msgpackr-extract-3.0.4/LICENSE"],
    };
  }
  if (pkg.name.startsWith("@opentui/core-") && pkg.version === "0.8.0") {
    return {
      source: "https://github.com/anomalyco/opentui/tree/v0.8.0",
      files: [
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE",
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE-GHOSTTY",
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE-LCMS2",
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE-LIBWEBP",
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE-STB",
        "third-party/reviewed/npm/opentui-core-0.8.0/LICENSE-WUFFS",
        "third-party/reviewed/npm/opentui-core-0.8.0/PATENTS-LIBWEBP",
        "third-party/reviewed/npm/opentui-core-0.8.0/AUTHORS-LIBWEBP",
      ],
    };
  }
  return undefined;
}

// `bun build --compile` embeds the Bun runtime that runs the build, so every release binary ships the version that
// built it. The WebKit and tinycc commits are WEBKIT_VERSION and TINYCC_COMMIT in scripts/build/deps/ of the Bun tag.
// The version equals the `packageManager` field of package.json, which `checkThirdPartyLicenses` enforces. The
// components manifest lists the other third-party code in the runtime, as Bun's LICENSE.md names it, with the reviewed
// texts that scripts/review-bun-runtime-licenses.ts fetched at pinned upstream commits.
const BUN_RUNTIME = {
  version: "1.4.4",
  source: "https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md",
  webkitSource: "https://github.com/oven-sh/WebKit/tree/d6375c72affe0f70222cdcb45012b10f0bf3a9d5",
  tinyccSource: "https://github.com/oven-sh/tinycc/tree/05f0fafaa3be31e31d7b4b5c17dc60f62c991171",
  files: [
    "third-party/reviewed/runtime/bun-1.4.4/LICENSE.md",
    "third-party/reviewed/licenses/MIT.txt",
    "third-party/reviewed/runtime/bun-1.4.4/JavaScriptCore-COPYING.LIB",
    "third-party/reviewed/runtime/bun-1.4.4/tinycc-COPYING",
  ],
  components: "third-party/reviewed/runtime/bun-1.4.4/components.json",
} as const;

/**
 * Fails a release build whose Bun differs from the runtime that the bundle documents, because the distributed binary
 * would embed an unreviewed runtime. Linting, generation, and local builds do not check the local Bun.
 */
export function assertEmbeddedBunRuntimeReviewed(): void {
  if (Bun.version !== BUN_RUNTIME.version) throw new Error(`The release binary would embed Bun ${Bun.version}, but THIRD-PARTY-LICENSES.txt documents Bun ${BUN_RUNTIME.version}. Review the new runtime legal files and update BUN_RUNTIME.`);
}

async function bunRuntimeSection(root: string): Promise<string> {
  const documents = await Promise.all(BUN_RUNTIME.files.map(async (relative) => ({ name: relative, text: await readFile(join(root, relative), "utf8") })));
  return `================================================================================\nbun@${BUN_RUNTIME.version} (runtime embedded in the flywheel binary)\nLicense source: ${BUN_RUNTIME.source}\nJavaScriptCore and WebKit source (LGPL-2): ${BUN_RUNTIME.webkitSource}\ntinycc source (LGPL-2.1): ${BUN_RUNTIME.tinyccSource}\n================================================================================\n\n${documents.map(appendDocument).join("\n")}`;
}

function runtimeComponent(value: unknown): ReviewedRuntimeComponent {
  const files = isRecord(value) ? stringArray(value["files"]) : undefined;
  if (!isRecord(value) || typeof value["name"] !== "string" || typeof value["license"] !== "string" || typeof value["source"] !== "string" || files === undefined) throw new Error(`${BUN_RUNTIME.components} has a malformed component`);
  return { name: value["name"], license: value["license"], source: value["source"], files };
}

// One section per third-party component of the Bun runtime. Many components carry the same license text, such as the
// Apache License 2.0, so a text that is byte-identical to one that an earlier component printed is named, not repeated.
// Texts that differ in any byte, such as two MIT texts with different copyright lines, are all printed.
async function bunRuntimeComponentSections(root: string): Promise<string[]> {
  const manifest: unknown = JSON.parse(await readFile(join(root, BUN_RUNTIME.components), "utf8"));
  if (!Array.isArray(manifest)) throw new Error(`${BUN_RUNTIME.components} is not a component list`);
  const printed = new Map<string, string>();
  const sections: string[] = [];
  for (const component of manifest.map(runtimeComponent)) {
    const documents: string[] = [];
    for (const relative of component.files) {
      const text = (await readFile(join(root, relative), "utf8")).replace(/\r\n?/gu, "\n");
      const earlier = printed.get(text);
      if (earlier === undefined) printed.set(text, relative);
      documents.push(earlier === undefined ? appendDocument({ name: relative, text }) : `--- ${relative} ---\nIdentical to ${earlier} above.\n`);
    }
    sections.push(`================================================================================\nbun@${BUN_RUNTIME.version} component: ${component.name}\nLicense: ${component.license}\nLicense source: ${component.source}\n================================================================================\n\n${documents.join("\n")}`);
  }
  return sections;
}

// `zig cc` links its compiler-rt and the mingw-w64 startup code statically into the committed Windows launchers and Git
// forwarder under crates/. The mingw-w64 objects that they link are public domain or ZPL-2.1, which asks a binary to
// carry its notice. Review these files again when a rebuild uses another Zig version.
const ZIG_TOOLCHAIN = {
  version: "0.15.2",
  source: "https://github.com/ziglang/zig/tree/0.15.2",
  files: [
    "third-party/reviewed/runtime/zig-0.15.2/LICENSE",
    "third-party/reviewed/runtime/zig-0.15.2/mingw-w64-COPYING",
  ],
} as const;

// src/infra/llm/models-bundled.txt is a snapshot of the models.dev catalog, which scripts/refresh-models-snapshot.ts
// fetches. The catalog data is MIT-licensed, so every binary that bundles the snapshot carries its notice.
const MODELS_DEV_CATALOG = {
  source: "https://github.com/anomalyco/models.dev/blob/d298380ee36b7e01261e5234d1f62d9a5f2955d3/LICENSE",
  files: ["third-party/reviewed/data/models.dev/LICENSE"],
} as const;

async function reviewedComponentSection(root: string, heading: string, component: { readonly source: string; readonly files: readonly string[] }): Promise<string> {
  const documents = await Promise.all(component.files.map(async (relative) => ({ name: relative, text: await readFile(join(root, relative), "utf8") })));
  return `================================================================================\n${heading}\nLicense source: ${component.source}\n================================================================================\n\n${documents.map(appendDocument).join("\n")}`;
}

function appendDocument(document: LegalDocument): string {
  const text = document.text.replace(/\r\n?/gu, "\n");
  return `--- ${document.name} ---\n${text}${text.endsWith("\n") ? "" : "\n"}`;
}

/** Generates the npm portion of the license bundle from a parsed lockfile. */
export async function generateNpmLicenseSections(root: string, lock: unknown): Promise<string[]> {
  const { packages, keys } = productionNpmPackageKeys(lock);
  const reviewed = await reviewedSources(root);
  const selected = [...keys].map((key) => packages.get(key)).filter((pkg): pkg is LockedPackage => pkg !== undefined).sort((left, right) => left.identity.localeCompare(right.identity));
  const sections: string[] = [];
  let installed: ReadonlyMap<string, string> | undefined;
  const installedDirectories = (): ReadonlyMap<string, string> => {
    installed ??= installedPackageDirectories(root);
    return installed;
  };
  for (const pkg of selected) {
    const authority = nativeFamilySource(root, pkg) ?? reviewed.get(pkg.identity);
    let source: string;
    let documents: LegalDocument[];
    if (authority !== undefined) {
      source = authority.source;
      documents = await Promise.all(authority.files.map(async (relative) => ({ name: relative, text: await readFile(join(root, relative), "utf8") })));
    } else {
      const directory = packageDirectory(root, pkg, installedDirectories);
      if (directory === undefined) throw new Error(`${pkg.identity} is not installed and has no exact reviewed legal source`);
      documents = await legalDocuments(directory);
      if (documents.length === 0) throw new Error(`${pkg.identity} has no legal file and no exact reviewed legal source`);
      source = `published package ${pkg.identity}`;
    }
    sections.push(`================================================================================\n${pkg.identity}\nLicense source: ${source}\n================================================================================\n\n${documents.map(appendDocument).join("\n")}`);
  }
  return sections;
}

/** Generates the deterministic dependency-license bundle without modifying the repository. */
export async function generateThirdPartyLicenses(root: string): Promise<string> {
  const lock: unknown = parse(await readFile(join(root, "bun.lock"), "utf8"));
  const sections = [
    await bunRuntimeSection(root),
    ...await bunRuntimeComponentSections(root),
    await reviewedComponentSection(root, `zig@${ZIG_TOOLCHAIN.version} compiler-rt and mingw-w64 runtime (statically linked into the Windows launchers)`, ZIG_TOOLCHAIN),
    await reviewedComponentSection(root, "models.dev catalog data (bundled as the model catalog snapshot)", MODELS_DEV_CATALOG),
    ...await generateNpmLicenseSections(root, lock),
  ];
  const ripgrep = join(root, "crates", "ripgrep");
  if (!(await cargoLicenseLedgerIsCurrent(ripgrep))) throw new Error("crates/ripgrep/THIRD-PARTY-LICENSES.txt is missing, malformed, or stale");
  const cargoFiles = [
    "crates/ripgrep/THIRD-PARTY-LICENSES.txt",
    "crates/ripgrep/LICENSE.omp",
    "crates/tokenizer/NOTICE.md",
    "crates/tokenizer/LICENSE.omp",
    "crates/tokenizer/LICENSE.ctok",
    "crates/tokenizer/LICENSE.tiktoken",
    "crates/tokenizer/LICENSE.xutf",
    "crates/tokenizer/LICENSE.rust-std-MIT",
    "crates/tokenizer/LICENSE.rust-std-APACHE",
    "crates/tokenizer/COPYRIGHT-library",
  ];
  for (const relative of cargoFiles) {
    const text = await readFile(join(root, relative), "utf8");
    sections.push(`================================================================================\n${relative}\n================================================================================\n\n${text}${text.endsWith("\n") ? "" : "\n"}`);
  }
  return `Flywheel third-party license bundle

Generated from bun.lock, exact reviewed upstream legal sources, and committed native-crate ledgers. Do not edit by hand.

Sharp distributes libvips 8.18.7 and its dependency set as separately replaceable shared libraries through sharp-libvips 1.3.4. Exact corresponding source: https://github.com/lovell/sharp-libvips/tree/v1.3.4

The flywheel binary embeds the Bun ${BUN_RUNTIME.version} runtime, which statically links JavaScriptCore and WebKit under LGPL-2 and tinycc under LGPL-2.1. Exact corresponding source: ${BUN_RUNTIME.webkitSource} and ${BUN_RUNTIME.tinyccSource}. Bun's own source and relink instructions: https://github.com/oven-sh/bun/tree/bun-v${BUN_RUNTIME.version}. The runtime also contains the other third-party code that Bun's license file names; each has a "bun@${BUN_RUNTIME.version} component" section below. Bun names no version for the code it ports from other projects, so the source of such a section is the upstream commit whose texts were reviewed.

${sections.join("\n")}`;
}

export async function checkThirdPartyLicenses(root: string): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageManager = isRecord(manifest) ? manifest.packageManager : undefined;
  if (packageManager !== `bun@${BUN_RUNTIME.version}`) throw new Error(`package.json names packageManager ${String(packageManager)}, but ${OUTPUT} documents Bun ${BUN_RUNTIME.version}. Review the new runtime legal files and update BUN_RUNTIME.`);
  const expected = await generateThirdPartyLicenses(root);
  const actual = await readFile(join(root, OUTPUT), "utf8");
  if (actual !== expected) throw new Error(`${OUTPUT} is stale; run bun run licenses:generate`);
}

export async function writeThirdPartyLicenses(root: string): Promise<void> {
  const destination = join(root, OUTPUT);
  const temporary = `${destination}.${process.pid}.tmp`;
  await Bun.write(temporary, await generateThirdPartyLicenses(root));
  await rename(temporary, destination);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  if (process.argv.includes("--check")) await checkThirdPartyLicenses(root);
  else await writeThirdPartyLicenses(root);
}
