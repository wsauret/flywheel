/** The release manifest is the whole public update contract: what a client
 *  downloads, from where, and what bytes it must be. So the emitter refuses
 *  anything it cannot state exactly - an archive it has no checksum for, a
 *  checksum stated twice, an archive that is not one of the release targets, or a
 *  target that was not built. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeReleaseManifest } from "../../../scripts/build-release-manifest.js";
import { RELEASE_TARGETS } from "../../../scripts/release-contract.js";
import { platformAssetName, selectReleaseAsset } from "../../../src/infra/update/release-manifest.js";

const VERSION = "1.4.2";
const REPOSITORY = "wsauret/flywheel";

interface Archive {
  readonly name: string;
  readonly bytes: string;
}
interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

interface ReleaseManifest {
  readonly assets: ReleaseAsset[];
  readonly version: string;
  readonly tag: string;
}

function archives(): readonly Archive[] {
  return RELEASE_TARGETS.map((target) => ({ name: `flywheel-${target}.tar.gz`, bytes: `payload of ${target}` }));
}

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withDist(run: (distDir: string) => Promise<void>, options: { readonly built?: readonly Archive[]; readonly checksums?: readonly Archive[] } = {}): Promise<void> {
  const distDir = mkdtempSync(join(tmpdir(), "flywheel-release-"));
  try {
    for (const archive of options.built ?? archives()) writeFileSync(join(distDir, archive.name), archive.bytes);
    const lines = (options.checksums ?? options.built ?? archives()).map((archive) => `${digest(archive.bytes)}  ${archive.name}`);
    writeFileSync(join(distDir, "SHASUMS256.txt"), `${lines.join("\n")}\n`);
    await run(distDir);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
}

function compose(distDir: string): Promise<string> {
  return composeReleaseManifest({ distDir, repository: REPOSITORY, version: VERSION });
}

describe("the release manifest", () => {
  test("states every published archive with its immutable URL, size, and digest", async () => {
    await withDist(async (distDir) => {
      const manifest: ReleaseManifest = JSON.parse(await compose(distDir));
      expect(manifest).toMatchObject({ version: VERSION, tag: `v${VERSION}` });

      const assets = manifest.assets;
      expect(assets.map((asset) => asset.name)).toEqual(archives().map((archive) => archive.name));
      for (const [index, asset] of assets.entries()) {
        const archive = archives()[index];
        expect(asset.url).toBe(`https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${asset.name}`);
        expect(asset.size).toBe(Buffer.byteLength(archive?.bytes ?? ""));
        expect(asset.sha256).toBe(digest(archive?.bytes ?? ""));
      }
    });
  });

  test("refuses an archive the checksum file does not state", async () => {
    await withDist(
      async (distDir) => { await expect(compose(distDir)).rejects.toThrow(/SHASUMS256/); },
      { checksums: archives().slice(1) },
    );
  });

  test("refuses a checksum stated twice", async () => {
    await withDist(
      async (distDir) => { await expect(compose(distDir)).rejects.toThrow(/twice/); },
      { checksums: [...archives(), archives()[0] ?? (() => { throw new Error("release fixture needs an archive") })()] },
    );
  });

  test("refuses a target that was not built", async () => {
    await withDist(
      async (distDir) => { await expect(compose(distDir)).rejects.toThrow(/flywheel-linux-x64\.tar\.gz/); },
      { built: archives().filter((archive) => !archive.name.includes("linux-x64")), checksums: archives() },
    );
  });

  test("refuses an archive that is not one of the five published targets", async () => {
    await withDist(
      async (distDir) => { await expect(compose(distDir)).rejects.toThrow(/flywheel-linux-riscv64\.tar\.gz/); },
      { checksums: [...archives(), { name: "flywheel-linux-riscv64.tar.gz", bytes: "surprise" }] },
    );
  });

  test("refuses an archive whose bytes are not the ones the checksum states", async () => {
    await withDist(
      async (distDir) => { await expect(compose(distDir)).rejects.toThrow(/digest/); },
      { built: archives(), checksums: archives().map((archive, index) => (index === 0 ? { ...archive, bytes: "other" } : archive)) },
    );
  });
});

/** The one seam neither side can test alone.
 *
 *  The publisher composes `release.json` and every installed client parses it.
 *  Each half has its own tests above and in `release-manifest.test.ts`, but a
 *  field renamed, a URL shape changed, or a strictness added on either side
 *  would pass both of those and still leave every installed Flywheel unable to
 *  find an update - the one failure no later release can repair, because the
 *  clients that cannot read the manifest are the clients that cannot update.
 *  So the generator's real output is handed to the real client selector. */
describe("what the publisher writes and every client reads", () => {
  test("the composed manifest is the one an installed client selects its own asset from", async () => {
    await withDist(async (distDir) => {
      const manifest = await compose(distDir);
      for (const target of RELEASE_TARGETS) {
        const assetName = platformAssetName(target);
        expect(assetName).toBe(`flywheel-${target}.tar.gz`);

        const selected = selectReleaseAsset(manifest, { assetName });

        expect(selected.version.canonical).toBe(VERSION);
        expect(selected.asset.name).toBe(assetName);
        expect(selected.asset.url).toBe(`https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${assetName}`);
        expect(selected.asset.sizeBytes).toBe(`payload of ${target}`.length);
        expect(selected.asset.sha256).toBe(digest(`payload of ${target}`));
      }
    });
  });

  test("a client asking for a platform this release does not publish is refused, not guessed at", async () => {
    await withDist(async (distDir) => {
      const manifest = await compose(distDir);

      expect(() => selectReleaseAsset(manifest, { assetName: platformAssetName("freebsd-x64") })).toThrow("publishes no flywheel-freebsd-x64.tar.gz");
    });
  });
});
