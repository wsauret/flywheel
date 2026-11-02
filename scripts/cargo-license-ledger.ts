import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isRecord } from "../src/infra/record.js";

interface CargoPackage {
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly license: string | null;
  readonly source: string | null;
  readonly repository: string | null;
}

interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
}

interface ReviewedCargoSource {
  readonly source: string;
  readonly file: string;
}

const LEGAL_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*|$)|third[-_ ]party.*(?:notice|licen[cs]e)/iu;
const SECTION = /^={80}\n([^@\n]+)@([^\n]+)\nSPDX:/gmu;

const REVIEWED_CARGO_SOURCES = new Map<string, ReviewedCargoSource>([
  ["pcre2-sys@0.2.10", {
    source: "https://github.com/PCRE2Project/pcre2/blob/pcre2-10.46/LICENCE.md",
    file: "third-party/reviewed/cargo/pcre2-sys/LICENSE",
  }],
  ["r-efi@6.0.0", {
    source: "https://github.com/r-efi/r-efi/blob/7e1b0322d31d625f81a5656096330934f9cd835d/AUTHORS",
    file: "third-party/reviewed/cargo/r-efi/AUTHORS",
  }],
  ["napi-build@2.3.2", {
    source: "https://github.com/napi-rs/napi-rs/blob/e9c50bb430b7d34659c0541f600e1e323d37432a/LICENSE",
    file: "third-party/reviewed/cargo/napi-rs/LICENSE",
  }],
  ["napi-derive-backend@5.0.4", {
    source: "https://github.com/napi-rs/napi-rs/blob/5ed87dd7e930961e9273f95cd0ed77c2da967bc1/LICENSE",
    file: "third-party/reviewed/cargo/napi-rs/LICENSE",
  }],
  ["napi-derive@3.5.6", {
    source: "https://github.com/napi-rs/napi-rs/blob/e9c50bb430b7d34659c0541f600e1e323d37432a/LICENSE",
    file: "third-party/reviewed/cargo/napi-rs/LICENSE",
  }],
  ["napi-sys@3.2.1", {
    source: "https://github.com/napi-rs/napi-rs/blob/be4b16ca00aa2cecd19be6ffe6de59495b471b14/LICENSE",
    file: "third-party/reviewed/cargo/napi-rs/LICENSE",
  }],
  ["napi@3.9.0", {
    source: "https://github.com/napi-rs/napi-rs/blob/e9c50bb430b7d34659c0541f600e1e323d37432a/LICENSE",
    file: "third-party/reviewed/cargo/napi-rs/LICENSE",
  }],
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cargoLockPackageIdentities(text: string): string[] {
  const identities: string[] = [];
  for (const block of text.split("[[package]]").slice(1)) {
    if (!/^source = /mu.test(block)) continue;
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    if (name === undefined || version === undefined) throw new Error("Cargo.lock contains a malformed registry package");
    identities.push(`${name}@${version}`);
  }
  return identities.sort();
}

async function cargoMetadata(crateDir: string): Promise<CargoMetadata> {
  const process = Bun.spawn(["cargo", "metadata", "--locked", "--format-version", "1"], {
    cwd: crateDir,
    stdout: "pipe",
    stderr: "inherit",
    windowsHide: true,
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`cargo metadata failed for ${crateDir}`);
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) throw new Error(`cargo metadata returned an invalid package list for ${crateDir}`);
  const packages: CargoPackage[] = [];
  for (const value of parsed["packages"]) {
    if (
      !isRecord(value)
      || typeof value["name"] !== "string"
      || typeof value["version"] !== "string"
      || typeof value["manifest_path"] !== "string"
      || !(typeof value["license"] === "string" || value["license"] === null)
      || !(typeof value["source"] === "string" || value["source"] === null)
      || !(typeof value["repository"] === "string" || value["repository"] === null)
    ) {
      throw new Error(`cargo metadata returned an invalid package for ${crateDir}`);
    }
    packages.push({
      name: value["name"],
      version: value["version"],
      manifest_path: value["manifest_path"],
      license: value["license"],
      source: value["source"],
      repository: value["repository"],
    });
  }
  return { packages };
}

function appendDocument(name: string, text: string): string {
  return `--- ${name} ---\n${text}${text.endsWith("\n") ? "" : "\n"}`;
}

/** Rebuilds the committed license ledger while Cargo's registry sources are available. */
export async function refreshCargoLicenseLedger(crateDir: string): Promise<void> {
  const metadata = await cargoMetadata(crateDir);
  const repositoryRoot = resolve(crateDir, "..", "..");
  const ownManifest = join(crateDir, "Cargo.toml");
  const packages = metadata.packages
    .filter((pkg) => pkg.source !== null && pkg.manifest_path !== ownManifest)
    .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  const sections: string[] = [];
  const legalFilesByRepository = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.repository === null) continue;
    const packageDir = dirname(pkg.manifest_path);
    const legalFiles = (await readdir(packageDir)).filter((name) => LEGAL_FILE.test(name)).sort();
    if (legalFiles.length > 0) legalFilesByRepository.set(pkg.repository, packageDir);
  }
  for (const pkg of packages) {
    const identity = `${pkg.name}@${pkg.version}`;
    const reviewed = REVIEWED_CARGO_SOURCES.get(identity);
    let source: string;
    let documents: string[];
    if (reviewed !== undefined) {
      const text = await readFile(join(repositoryRoot, reviewed.file), "utf8");
      source = reviewed.source;
      documents = [appendDocument(reviewed.file, text)];
    } else {
      let packageDir = dirname(pkg.manifest_path);
      let legalFiles = (await readdir(packageDir)).filter((name) => LEGAL_FILE.test(name)).sort();
      if (legalFiles.length === 0 && pkg.repository !== null) {
        packageDir = legalFilesByRepository.get(pkg.repository) ?? packageDir;
        legalFiles = (await readdir(packageDir)).filter((name) => LEGAL_FILE.test(name)).sort();
      }
      if (legalFiles.length === 0) throw new Error(`${identity} has no exact Cargo legal source`);
      source = pkg.source ?? "unknown";
      documents = await Promise.all(legalFiles.map(async (name) => appendDocument(name, await readFile(join(packageDir, name), "utf8"))));
    }
    sections.push(`================================================================================\n${identity}\nSPDX: ${pkg.license ?? "not declared"}\nSource: ${source}\n================================================================================\n\n${documents.join("\n")}`);
  }
  const lock = await readFile(join(crateDir, "Cargo.lock"));
  const content = `Generated from Cargo.lock. Regenerate through the owning native crate build.\nCargo.lock SHA-256: ${sha256(lock)}\n\n${sections.join("\n")}`;
  const destination = join(crateDir, "THIRD-PARTY-LICENSES.txt");
  const temporary = `${destination}.${process.pid}.tmp`;
  await Bun.write(temporary, content);
  await rename(temporary, destination);
}

/** Checks that one committed ledger exactly covers the registry packages in its lockfile. */
export async function cargoLicenseLedgerIsCurrent(crateDir: string): Promise<boolean> {
  const destination = join(crateDir, "THIRD-PARTY-LICENSES.txt");
  if (!existsSync(destination)) return false;
  try {
    const [lock, ledger] = await Promise.all([readFile(join(crateDir, "Cargo.lock")), readFile(destination, "utf8")]);
    if (!ledger.startsWith(`Generated from Cargo.lock. Regenerate through the owning native crate build.\nCargo.lock SHA-256: ${sha256(lock)}\n\n`)) return false;
    if (ledger.includes("synthesized")) return false;
    const expected = cargoLockPackageIdentities(lock.toString("utf8"));
    const actual = [...ledger.matchAll(SECTION)].map((match) => `${match[1]}@${match[2]}`).sort();
    return actual.length === expected.length && actual.every((identity, index) => identity === expected[index]);
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const crate = process.argv[2];
  if (crate === undefined) throw new Error("usage: bun run scripts/cargo-license-ledger.ts <crate-directory>");
  await refreshCargoLicenseLedger(resolve(crate));
}
