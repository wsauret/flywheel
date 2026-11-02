import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageClaudeEngine, verifyClaudeEngine } from "../../../scripts/claude-engine-asset.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();
const SDK = "@anthropic-ai/claude-agent-sdk";
const VERSION = "0.3.296";
const ENGINE = new TextEncoder().encode("the pinned engine");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** A checkout whose lockfile pins the SDK and the platform packages of `tarballs`, whose node_modules holds the SDK at
 *  the locked version with a manifest that states `ENGINE` for every platform, and whose build cache holds `cached`. */
async function checkout(options: { readonly installed?: { readonly platformArch: string; readonly version: string; readonly bytes: Uint8Array }; readonly cached?: { readonly platformArch: string; readonly tarball: Uint8Array; readonly integrity?: string } }) {
  const root = temporaryDirectory("claude-engine-root-");
  const platforms = ["darwin-arm64", "linux-x64-musl", "win32-x64"];
  const integrity = (platformArch: string) => options.cached?.platformArch === platformArch ? options.cached.integrity ?? sha512(options.cached.tarball) : "sha512-unused";
  const packages = Object.fromEntries([
    [SDK, [`${SDK}@${VERSION}`, "", {}, "sha512-sdk"]],
    ...platforms.map((platformArch) => [`${SDK}-${platformArch}`, [`${SDK}-${platformArch}@${VERSION}`, "", {}, integrity(platformArch)]]),
  ]);
  // bun.lock is JSONC: a trailing comma is valid in it.
  writeFileSync(join(root, "bun.lock"), `${JSON.stringify({ lockfileVersion: 1, packages }, null, 2).slice(0, -2)},\n}\n`);
  const sdkDir = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: SDK, version: VERSION }));
  writeFileSync(join(sdkDir, "manifest.json"), JSON.stringify({ version: "2.1.296", platforms: Object.fromEntries(platforms.map((platformArch) => [platformArch, {
    binary: platformArch.startsWith("win32-") ? "claude.exe" : "claude", checksum: sha256(ENGINE), size: ENGINE.byteLength,
  }])) }));
  if (options.installed !== undefined) {
    const packageDir = join(root, "node_modules", "@anthropic-ai", `claude-agent-sdk-${options.installed.platformArch}`);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: options.installed.version }));
    writeFileSync(join(packageDir, "claude"), options.installed.bytes);
  }
  if (options.cached !== undefined) {
    const cache = join(root, "node_modules", ".cache", "claude-engine");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `claude-agent-sdk-${options.cached.platformArch}-${VERSION}.tgz`), options.cached.tarball);
  }
  return root;
}

async function tarball(binary: string, bytes: Uint8Array): Promise<Uint8Array> {
  return new Bun.Archive({ [`package/${binary}`]: bytes, "package/package.json": "{}" }, { compress: "gzip" }).bytes();
}

describe("the Claude engine of a release archive", () => {
  test("stages the installed platform package of the locked version, executable, and the staged engine verifies", async () => {
    const root = await checkout({ installed: { platformArch: "darwin-arm64", version: VERSION, bytes: ENGINE } });
    const native = temporaryDirectory("claude-engine-native-");

    await stageClaudeEngine(root, native, "darwin-arm64");

    expect(readFileSync(join(native, "claude"))).toEqual(Buffer.from(ENGINE));
    if (process.platform !== "win32") expect(statSync(join(native, "claude")).mode & 0o111).not.toBe(0);
    await expect(verifyClaudeEngine(root, native, "darwin-arm64")).resolves.toBeUndefined();
  });

  test("a cross build takes the engine from the lockfile's tarball of the target, never from another platform's package", async () => {
    const root = await checkout({
      installed: { platformArch: "darwin-arm64", version: VERSION, bytes: new TextEncoder().encode("the host engine") },
      cached: { platformArch: "win32-x64", tarball: await tarball("claude.exe", ENGINE) },
    });
    const native = temporaryDirectory("claude-engine-native-");

    await stageClaudeEngine(root, native, "win32-x64");

    expect(readFileSync(join(native, "claude.exe"))).toEqual(Buffer.from(ENGINE));
    await expect(verifyClaudeEngine(root, native, "win32-x64")).resolves.toBeUndefined();
  });

  test("refuses an engine whose bytes the SDK manifest does not state, and stages nothing", async () => {
    const root = await checkout({ installed: { platformArch: "darwin-arm64", version: VERSION, bytes: new TextEncoder().encode("the pinned enginf") } });
    const native = temporaryDirectory("claude-engine-native-");

    await expect(stageClaudeEngine(root, native, "darwin-arm64")).rejects.toThrow("has SHA-256");
    expect(existsSync(join(native, "claude"))).toBe(false);
  });

  test("refuses a staged engine that changed after staging", async () => {
    const root = await checkout({ installed: { platformArch: "darwin-arm64", version: VERSION, bytes: ENGINE } });
    const native = temporaryDirectory("claude-engine-native-");
    await stageClaudeEngine(root, native, "darwin-arm64");

    writeFileSync(join(native, "claude"), "a different engine", { mode: 0o755 });

    await expect(verifyClaudeEngine(root, native, "darwin-arm64")).rejects.toThrow("is 18 bytes, and the SDK manifest states 17");
  });

  test("never uses a cached tarball that the lockfile's integrity does not name", async () => {
    const root = await checkout({ cached: { platformArch: "linux-x64-musl", tarball: await tarball("claude", ENGINE), integrity: sha512(new TextEncoder().encode("another tarball")) } });
    const native = temporaryDirectory("claude-engine-native-");
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    // The registry is the only other source; this one answers with the same wrong tarball.
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      fetches.push(String(input));
      return new Response((await tarball("claude", ENGINE)).slice());
    }, { preconnect: realFetch.preconnect });
    try {
      await expect(stageClaudeEngine(root, native, "linux-x64-musl")).rejects.toThrow("does not match the bun.lock integrity");
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(fetches).toEqual([`https://registry.npmjs.org/${SDK}-linux-x64-musl/-/claude-agent-sdk-linux-x64-musl-${VERSION}.tgz`]);
    expect(existsSync(join(native, "claude"))).toBe(false);
  });

  test("refuses an SDK in node_modules that is not the locked version", async () => {
    const root = await checkout({ installed: { platformArch: "darwin-arm64", version: VERSION, bytes: ENGINE } });
    writeFileSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), JSON.stringify({ name: SDK, version: "0.3.295" }));

    await expect(stageClaudeEngine(root, temporaryDirectory("claude-engine-native-"), "darwin-arm64")).rejects.toThrow("run bun install");
  });
});
