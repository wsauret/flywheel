import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareAntigravityEngine, stageAntigravityEngine, verifyAntigravityEngine } from "../../../scripts/antigravity-engine-asset.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();
const VERSION = "1.5.14";
const ENGINE = new TextEncoder().encode("the pinned agy");
const MAC_URL = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/darwin-arm/cli_mac_arm64.tar.gz";
const WINDOWS_URL = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/windows-x64/cli_windows_x64.exe";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers every request with the artifact of its URL from `artifacts`, and records each URL that it was asked for. */
function serveArtifacts(artifacts: ReadonlyMap<string, Uint8Array>): string[] {
  const fetches: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    fetches.push(url);
    const artifact = artifacts.get(url);
    return artifact === undefined ? new Response("not found", { status: 404 }) : new Response(artifact.slice());
  }, { preconnect: realFetch.preconnect });
  return fetches;
}

/** A checkout whose pin states `ENGINE` as the executable of darwin-arm64, in a tar.gz as member `antigravity`, and
 *  of win32-x64, as a bare exe. `pinnedMacArtifact` is the artifact whose sha512 the pin states for darwin-arm64. */
async function checkout(pinnedMacArtifact: Uint8Array): Promise<string> {
  const root = temporaryDirectory("antigravity-engine-root-");
  const engine = { size: ENGINE.byteLength, sha256: sha256(ENGINE) };
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "antigravity-engine-pin.json"), JSON.stringify({
    version: VERSION,
    build: "1.5.14-1",
    targets: {
      "darwin-arm64": { manifestTarget: "darwin_arm64", url: MAC_URL, sha512: sha512(pinnedMacArtifact), archive: "tar.gz", member: "antigravity", ...engine },
      "win32-x64": { manifestTarget: "windows_amd64", url: WINDOWS_URL, sha512: sha512(ENGINE), archive: "exe", ...engine },
    },
  }));
  return root;
}

async function macArtifact(bytes = ENGINE): Promise<Uint8Array> {
  return new Bun.Archive({ antigravity: bytes }, { compress: "gzip" }).bytes();
}

const checkoutCopy = (root: string, platformArch: string, file: string) => join(root, "node_modules", ".cache", "antigravity-engine", VERSION, platformArch, file);

describe("the pinned Antigravity CLI of a checkout", () => {
  test("is fetched once into an empty cache and verified, and a second preparation fetches nothing", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    const fetches = serveArtifacts(new Map([[MAC_URL, artifact]]));

    const path = await prepareAntigravityEngine(root, "darwin-arm64");
    await prepareAntigravityEngine(root, "darwin-arm64");

    expect(path).toBe(checkoutCopy(root, "darwin-arm64", "agy"));
    expect(readFileSync(path)).toEqual(Buffer.from(ENGINE));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(fetches).toEqual([MAC_URL]);
  });

  test("replaces a cached copy that the pin does not state with a fresh download", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    const cached = checkoutCopy(root, "darwin-arm64", "agy");
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, "a changed agy", { mode: 0o755 });
    const fetches = serveArtifacts(new Map([[MAC_URL, artifact]]));

    await prepareAntigravityEngine(root, "darwin-arm64");

    expect(readFileSync(cached)).toEqual(Buffer.from(ENGINE));
    expect(fetches).toEqual([MAC_URL]);
  });

  test("refuses a download whose sha512 is not the pinned one, and places nothing", async () => {
    const root = await checkout(await macArtifact());
    serveArtifacts(new Map([[MAC_URL, await macArtifact(new TextEncoder().encode("another agy"))]]));

    await expect(prepareAntigravityEngine(root, "darwin-arm64")).rejects.toThrow("does not match the pinned sha512");
    const directory = dirname(checkoutCopy(root, "darwin-arm64", "agy"));
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
  });

  test("refuses an artifact that matches the pinned sha512 but holds another executable, and places nothing", async () => {
    const artifact = await macArtifact(new TextEncoder().encode("the pinned agz"));
    const root = await checkout(artifact);
    serveArtifacts(new Map([[MAC_URL, artifact]]));

    await expect(prepareAntigravityEngine(root, "darwin-arm64")).rejects.toThrow("has SHA-256");
    const directory = dirname(checkoutCopy(root, "darwin-arm64", "agy"));
    expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
  });

  test("two preparations of an empty cache at the same time both resolve to the verified copy", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    const { promise: served, resolve: serve } = Promise.withResolvers<void>();
    let waiting = 0;
    globalThis.fetch = Object.assign(async () => {
      if (++waiting === 2) serve();
      await served;
      return new Response(artifact.slice());
    }, { preconnect: realFetch.preconnect });

    const paths = await Promise.all([prepareAntigravityEngine(root, "darwin-arm64"), prepareAntigravityEngine(root, "darwin-arm64")]);

    const copy = checkoutCopy(root, "darwin-arm64", "agy");
    expect(paths).toEqual([copy, copy]);
    expect(readFileSync(copy)).toEqual(Buffer.from(ENGINE));
    expect(readdirSync(dirname(copy))).toEqual(["agy"]);
  });

  test("names a target that the pin has no artifact for, and asks no server, not even for a manifest", async () => {
    const root = await checkout(await macArtifact());
    const fetches = serveArtifacts(new Map());

    await expect(prepareAntigravityEngine(root, "linux-x64-musl")).rejects.toThrow("names no artifact for linux-x64-musl");
    await expect(stageAntigravityEngine(root, temporaryDirectory("antigravity-engine-native-"), "linux-x64-musl")).rejects.toThrow("names no artifact for linux-x64-musl");
    expect(fetches).toEqual([]);
  });
});

describe("the Antigravity CLI of a release archive", () => {
  test("stages the pinned executable of each target under its target's name, executable, and it verifies", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    serveArtifacts(new Map([[MAC_URL, artifact], [WINDOWS_URL, ENGINE]]));
    const native = temporaryDirectory("antigravity-engine-native-");

    await stageAntigravityEngine(root, native, "darwin-arm64");
    await stageAntigravityEngine(root, native, "win32-x64");

    expect(readFileSync(join(native, "agy"))).toEqual(Buffer.from(ENGINE));
    expect(readFileSync(join(native, "agy.exe"))).toEqual(Buffer.from(ENGINE));
    if (process.platform !== "win32") expect(statSync(join(native, "agy")).mode & 0o777).toBe(0o755);
    await expect(verifyAntigravityEngine(root, native, "darwin-arm64")).resolves.toBeUndefined();
    await expect(verifyAntigravityEngine(root, native, "win32-x64")).resolves.toBeUndefined();
  });

  test("refuses a staged executable that changed by one byte after staging", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    serveArtifacts(new Map([[MAC_URL, artifact]]));
    const native = temporaryDirectory("antigravity-engine-native-");
    await stageAntigravityEngine(root, native, "darwin-arm64");

    writeFileSync(join(native, "agy"), "the pinned agz", { mode: 0o755 });

    await expect(verifyAntigravityEngine(root, native, "darwin-arm64")).rejects.toThrow("has SHA-256");
  });

  test.skipIf(process.platform === "win32")("refuses a staged executable without its executable bit", async () => {
    const artifact = await macArtifact();
    const root = await checkout(artifact);
    serveArtifacts(new Map([[MAC_URL, artifact]]));
    const native = temporaryDirectory("antigravity-engine-native-");
    await stageAntigravityEngine(root, native, "darwin-arm64");

    chmodSync(join(native, "agy"), 0o644);

    await expect(verifyAntigravityEngine(root, native, "darwin-arm64")).rejects.toThrow("is not executable");
  });
});
