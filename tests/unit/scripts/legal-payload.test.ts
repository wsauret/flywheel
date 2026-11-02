import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cargoLicenseLedgerIsCurrent } from "../../../scripts/cargo-license-ledger.js";
import {
  checkThirdPartyLicenses,
  generateNpmLicenseSections,
  productionNpmPackages,
  productionNpmPackagesFromLock,
} from "../../../scripts/generate-third-party-licenses.js";
import { LEGAL_PAYLOAD_FILES, stageLegalPayload } from "../../../scripts/legal-payload.js";
import { nativeAddonSourceSha256 } from "../../../scripts/native-addon-fingerprint.js";

const ROOT = resolve(import.meta.dir, "../../..");

interface StringDictionary {
  [key: string]: string;
}

interface UnknownDictionary {
  [key: string]: unknown;
}

function shippingLock(rootDependencies: StringDictionary, packages: UnknownDictionary, webviewDependencies: StringDictionary = {}) {
  return {
    workspaces: {
      "": { name: "root", dependencies: rootDependencies },
      webview: { name: "web", dependencies: webviewDependencies },
      relay: { name: "relay", dependencies: {} },
      vscode: { name: "vscode", dependencies: {} },
    },
    packages,
  };
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-licenses-"));
  mkdirSync(join(root, "third-party", "reviewed"), { recursive: true });
  writeFileSync(join(root, "third-party", "reviewed", "sources.json"), "{}\n");
  return root;
}

describe("release legal payload", () => {
  test("stages byte-identical legal payloads for every packaging family", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-legal-source-"));
    try {
      for (const name of LEGAL_PAYLOAD_FILES) writeFileSync(join(root, name), new Uint8Array([0, 1, 2, name.length]));
      for (const family of ["native", "webview", "relay", "vscode"]) {
        const destination = join(root, "artifacts", family);
        await stageLegalPayload(root, destination);
        for (const name of LEGAL_PAYLOAD_FILES) {
          expect(readFileSync(join(destination, name))).toEqual(readFileSync(join(root, name)));
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves each workspace from its own lock namespace", () => {
    const packages = productionNpmPackagesFromLock(shippingLock(
      { renderer: "1.0.0" },
      {
        renderer: ["renderer@1.0.0", "", {}],
        "web/renderer": ["renderer@2.0.0", "", {}],
      },
      { renderer: "2.0.0" },
    ));
    expect(packages).toEqual(new Set(["renderer@1.0.0", "renderer@2.0.0"]));
  });

  test("derives the repository graph without development dependencies", async () => {
    const packages = await productionNpmPackages(ROOT);
    expect(packages.has("highlight.js@11.11.1")).toBe(true);
    expect(packages.has("highlight.js@11.12.0")).toBe(true);
    expect(packages.has("marked@17.0.1")).toBe(true);
    expect(packages.has("marked@18.0.11")).toBe(true);
    expect(packages.has("zod@4.6.7")).toBe(true);
    expect([...packages].some((entry) => entry.startsWith("@types/bun@"))).toBe(false);
  });

  test("rejects a packageManager runtime whose legal files were not reviewed", async () => {
    const root = fixtureRoot();
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "bun@0.0.1" }));
      await expect(checkThirdPartyLicenses(root)).rejects.toThrow("package.json names packageManager bun@0.0.1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an installed package without an exact legal source", async () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "node_modules", "mystery"), { recursive: true });
      writeFileSync(join(root, "node_modules", "mystery", "package.json"), JSON.stringify({ name: "mystery", version: "1.0.0", license: "MIT" }));
      const lock = shippingLock({ mystery: "1.0.0" }, { mystery: ["mystery@1.0.0", "", {}] });
      await expect(generateNpmLicenseSections(root, lock)).rejects.toThrow("no legal file and no exact reviewed legal source");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes package legal files to repository line endings", async () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "node_modules", "example"), { recursive: true });
      writeFileSync(join(root, "node_modules", "example", "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
      writeFileSync(join(root, "node_modules", "example", "LICENSE"), "first\r\nsecond\rthird\n");
      const lock = shippingLock({ example: "1.0.0" }, { example: ["example@1.0.0", "", {}] });

      const [section] = await generateNpmLicenseSections(root, lock);

      expect(section).toContain("first\nsecond\nthird\n");
      expect(section).not.toContain("\r");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("native family attribution does not depend on foreign optional packages", async () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "node_modules", "sharp"), { recursive: true });
      writeFileSync(join(root, "node_modules", "sharp", "package.json"), JSON.stringify({ name: "sharp", version: "0.35.5" }));
      writeFileSync(join(root, "node_modules", "sharp", "LICENSE"), "owner license bytes\n");
      const lock = shippingLock(
        { sharp: "0.35.5" },
        {
          sharp: ["sharp@0.35.5", "", { optionalDependencies: { "@img/sharp-linux-x64": "0.35.5" } }],
          "@img/sharp-linux-x64": ["@img/sharp-linux-x64@0.35.5", "", {}],
        },
      );
      const absent = await generateNpmLicenseSections(root, lock);
      mkdirSync(join(root, "node_modules", "@img", "sharp-linux-x64"), { recursive: true });
      writeFileSync(join(root, "node_modules", "@img", "sharp-linux-x64", "package.json"), JSON.stringify({ name: "@img/sharp-linux-x64", version: "0.35.5" }));
      writeFileSync(join(root, "node_modules", "@img", "sharp-linux-x64", "LICENSE"), "host-specific bytes that must not become authority\n");
      expect(await generateNpmLicenseSections(root, lock)).toEqual(absent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects stale, incomplete, and malformed Cargo ledgers", async () => {
    const crate = mkdtempSync(join(tmpdir(), "flywheel-cargo-ledger-"));
    try {
      const lock = 'version = 4\n\n[[package]]\nname = "root"\nversion = "0.1.0"\n\n[[package]]\nname = "dep"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
      writeFileSync(join(crate, "Cargo.lock"), lock);
      const hash = createHash("sha256").update(lock).digest("hex");
      const header = `Generated from Cargo.lock. Regenerate through the owning native crate build.\nCargo.lock SHA-256: ${hash}\n\n`;
      writeFileSync(join(crate, "THIRD-PARTY-LICENSES.txt"), `${header}${"=".repeat(80)}\ndep@1.2.3\nSPDX: MIT\nSource: exact\n${"=".repeat(80)}\n\n--- LICENSE ---\nexact bytes\n`);
      expect(await cargoLicenseLedgerIsCurrent(crate)).toBe(true);
      writeFileSync(join(crate, "THIRD-PARTY-LICENSES.txt"), header);
      expect(await cargoLicenseLedgerIsCurrent(crate)).toBe(false);
      writeFileSync(join(crate, "THIRD-PARTY-LICENSES.txt"), `${header}synthesized MIT notice\n`);
      expect(await cargoLicenseLedgerIsCurrent(crate)).toBe(false);
    } finally {
      rmSync(crate, { recursive: true, force: true });
    }
  });

  test("Cargo.lock participates in native production fingerprints", async () => {
    const crate = mkdtempSync(join(tmpdir(), "flywheel-native-fingerprint-"));
    try {
      mkdirSync(join(crate, "src"));
      writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
      writeFileSync(join(crate, "Cargo.lock"), "version = 4\n");
      writeFileSync(join(crate, "build.rs"), "fn main() {}\n");
      writeFileSync(join(crate, "src", "lib.rs"), "pub fn fixture() {}\n");
      const before = await nativeAddonSourceSha256(crate);
      writeFileSync(join(crate, "Cargo.lock"), "version = 4\n# changed\n");
      expect(await nativeAddonSourceSha256(crate)).not.toBe(before);
    } finally {
      rmSync(crate, { recursive: true, force: true });
    }
  });
});
