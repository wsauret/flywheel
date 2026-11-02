/** The served-client acceptance end to end: a client's own update code,
 *  seeded with its own release and then asked to update to a staged release.
 *  Two clients are driven: v0.1.0 from its tagged source, and this tree, which
 *  is the client the next release ships. So a change here that breaks the
 *  driver's contract fails before it is tagged, not at the release after it.
 *
 *  Every release here is a tiny synthetic one that keeps every rule v0.1.0
 *  applies to a build: the archive root, `build.json` with its asset, the
 *  native, fonts, and webview directories, the Windows launchers, and a
 *  version line the host's executable prints from its own metadata. So a
 *  refusal is the rule the case breaks, and nothing else.
 *
 *  `FLYWHEEL_PRE_PUBLIC_SOURCE`: the path of a local Git repository that holds
 *  the tags of the releases cut before the source went public, such as the
 *  release gate's `pre-public-source.git` cache or a checkout of the archived
 *  development repository. The v0.1.0 cases read v0.1.0 from it, and they
 *  skip when it is not set: the release gate's own source is a private remote,
 *  and a test reads no remote repository. They install the tag's locked
 *  dependencies with `bun install`, which downloads what Bun's cache lacks,
 *  once for the file. No other case needs the network. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { materializeShippedSource, PRE_PUBLIC_RELEASES, updaterGeneration } from "../../../scripts/release-acceptance.js";
import { RELEASE_TARGET_MATRIX } from "../../../scripts/release-contract.js";
import { computeBuildId } from "../../../src/infra/update/build-identity.js";
import { tarBlocks, type TarEntrySpec } from "../../helpers/tar-archive.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DRIVER = join(ROOT, "scripts", "release-acceptance-driver.ts");
const REPOSITORY = "wsauret/flywheel";
const HOST = `${process.platform}-${process.arch}`;

/** The targets v0.1.0 updates on, as its own `RELEASE_TARGET_MATRIX` states them. */
const V0_1_0_TARGETS = [
  ["darwin-arm64", "darwin"], ["darwin-x64", "darwin"],
  ["linux-arm64", "linux"], ["linux-arm64-musl", "linux"], ["linux-x64", "linux"], ["linux-x64-musl", "linux"],
  ["win32-arm64", "win32"], ["win32-x64", "win32"],
] as const;

/** The targets this tree updates on. */
const TREE_TARGETS = RELEASE_TARGET_MATRIX.map(({ platformArch, platform }) => [platformArch, platform] as const);
const TREE_PACKAGE: unknown = await Bun.file(join(ROOT, "package.json")).json();
const TREE_VERSION = typeof TREE_PACKAGE === "object" && TREE_PACKAGE !== null && "version" in TREE_PACKAGE && typeof TREE_PACKAGE.version === "string" ? TREE_PACKAGE.version : "";

/** The host runs its own target's executable, which here is a shell script,
 *  so the host must be one of the client's POSIX targets. */
const posixHostOf = (targets: readonly (readonly [string, string])[]) => describe.skipIf(process.platform === "win32" || !targets.some(([target]) => target === HOST));

let scratch: string;
let gateHome: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flywheel-release-acceptance-driver-"));
  gateHome = process.env.FLYWHEEL_PERF_GATE_HOME;
  process.env.FLYWHEEL_PERF_GATE_HOME = join(scratch, "gate-home");
});

afterAll(() => {
  if (gateHome === undefined) delete process.env.FLYWHEEL_PERF_GATE_HOME;
  else process.env.FLYWHEEL_PERF_GATE_HOME = gateHome;
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

/** One target's archive, built the way the release build writes it. */
function archive(platformArch: string, platform: string, version: string): Uint8Array {
  const tree = mkdtempSync(join(scratch, "tree-"));
  const executable = platform === "win32" ? "flywheel-bin.exe" : "flywheel-bin";
  // The executable prints the version line v0.1.0 expects from the metadata
  // beside it, as a real build does.
  const script = `#!/bin/sh\nid=$(sed -n 's/.*"buildId":"\\([0-9a-f]*\\)".*/\\1/p' "$(dirname "$0")/build.json")\necho "flywheel ${version} (build $id)"\n`;
  const files: { readonly path: string; readonly mode: number; readonly content: string }[] = [
    { path: executable, mode: 0o755, content: script },
    { path: `native/${platformArch}/native.txt`, mode: 0o644, content: "native" },
    { path: "fonts/font.txt", mode: 0o644, content: "font" },
    { path: "webview/index.html", mode: 0o644, content: "<!doctype html>" },
    ...(platform === "win32" ? [{ path: `native/${platformArch}/flywheel-launcher.exe`, mode: 0o755, content: "launcher" }, { path: `native/${platformArch}/flywheel-service-launcher.exe`, mode: 0o755, content: "service" }] : []),
  ];
  for (const file of files) {
    mkdirSync(join(tree, file.path, ".."), { recursive: true });
    writeFileSync(join(tree, file.path), file.content);
    chmodSync(join(tree, file.path), file.mode);
  }
  const buildId = computeBuildId(tree, platform);
  rmSync(tree, { recursive: true, force: true });
  const root = `flywheel-${platformArch}/build`;
  const directories = ["", "native", `native/${platformArch}`, "fonts", "webview"];
  return gzipSync(tarBlocks([
    ...directories.map((dir): TarEntrySpec => ({ name: `${root}/${dir}${dir === "" ? "" : "/"}`, typeflag: "5", mode: 0o755 })),
    ...files.map((file): TarEntrySpec => ({ name: `${root}/${file.path}`, typeflag: "0", mode: file.mode, content: file.content })),
    { name: `${root}/build.json`, typeflag: "0", mode: 0o644, content: JSON.stringify({ version, buildId, asset: `flywheel-${platformArch}.tar.gz` }) },
  ]));
}

/** A staged release of `version` for `targets`, as `release.json` and its
 *  archives in one directory. */
function release(version: string, targets: readonly (readonly [string, string])[] = V0_1_0_TARGETS): string {
  const dir = mkdtempSync(join(scratch, `release-${version}-`));
  const assets = targets.map(([platformArch, platform]) => {
    const name = `flywheel-${platformArch}.tar.gz`;
    const bytes = archive(platformArch, platform, version);
    writeFileSync(join(dir, name), bytes);
    return { name, url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  writeFileSync(join(dir, "release.json"), `${JSON.stringify({ version, tag: `v${version}`, assets }, null, 2)}\n`);
  return dir;
}

/** One served client, as the gate hands it to the driver: its source and
 *  the directory its own published release is seeded from. */
interface ServedClient {
  readonly source: string;
  readonly seed: string;
}

async function drive(client: ServedClient, candidate: string, options: { readonly repository?: string } = {}): Promise<{ readonly code: number; readonly lines: readonly string[] }> {
  const work = mkdtempSync(join(scratch, "work-"));
  const child = Bun.spawn([
    "bun", "run", DRIVER, "--source", client.source, "--manifest", join(candidate, "release.json"), "--dist", candidate,
    "--repository", options.repository ?? REPOSITORY, "--seed", client.seed, "--work", work, "--host", HOST,
  ], { cwd: ROOT, env: { ...process.env, HOME: work, USERPROFILE: work, FLYWHEEL_LOG_LEVEL: "error" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, lines: output.split("\n").filter((line) => line.trim() !== "") };
}

const prePublicSource = process.env.FLYWHEEL_PRE_PUBLIC_SOURCE ?? "";
const v0_1_0Client = prePublicSource === "" ? "the v0.1.0 client, skipped because FLYWHEEL_PRE_PUBLIC_SOURCE names no local repository with the pre-public tags" : "the v0.1.0 client";

describe.skipIf(prePublicSource === "")(v0_1_0Client, () => posixHostOf(V0_1_0_TARGETS)("over its own installation", () => {
  let client: ServedClient;
  beforeAll(() => {
    client = { source: materializeShippedSource("v0.1.0", ROOT, { tags: PRE_PUBLIC_RELEASES.tags, source: prePublicSource }), seed: release("0.1.0") };
  }, 600_000);

  test("accepts a release that keeps every rule it applies, on every target it updates on", async () => {
    const run = await drive(client, release("0.1.1"));

    expect(run.lines.filter((line) => line.startsWith("accepted")).map((line) => line.split(" ")[1])).toEqual(V0_1_0_TARGETS.map(([target]) => target));
    expect(run.lines.every((line) => line.includes("over v0.1.0"))).toBe(true);
    // The host's line shows both runs: v0.1.0's own build, seeded first, and
    // the staged one installed over it.
    expect(run.lines.find((line) => line.startsWith(`accepted ${HOST}`))).toMatch(/the seeded build answered "flywheel 0\.1\.0 \(build [0-9a-f]{64}\)", the staged one "flywheel 0\.1\.1 \(build [0-9a-f]{64}\)"/);
    expect(run.code).toBe(0);
  }, 300_000);

  test("refuses a release that drops a target it updates on", async () => {
    const run = await drive(client, release("0.1.1", V0_1_0_TARGETS.filter(([target]) => target !== "linux-arm64-musl")));

    expect(run.lines).toContain("refused linux-arm64-musl: The release manifest is not usable: the release publishes no flywheel-linux-arm64-musl.tar.gz");
    expect(run.code).toBe(1);
  }, 300_000);

  test("refuses a release published to a repository it does not trust", async () => {
    const run = await drive(client, release("0.1.1"), { repository: "acme/flywheel" });

    expect(run.lines).toEqual(["refused repository: the release publishes to acme/flywheel, but v0.1.0 checks and downloads only from wsauret/flywheel"]);
    expect(run.code).toBe(1);
  }, 300_000);
}));

/** The next patch release after `version`. */
function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

posixHostOf(TREE_TARGETS)("this tree, as the client the next release serves", () => {
  test("accepts the next release over its own installation, on every target it updates on", async () => {
    const run = await drive({ source: ROOT, seed: release(TREE_VERSION, TREE_TARGETS) }, release(nextPatch(TREE_VERSION), TREE_TARGETS));

    expect(run.lines.filter((line) => line.startsWith("accepted")).map((line) => line.split(" ")[1])).toEqual(TREE_TARGETS.map(([target]) => target));
    expect(run.lines.every((line) => line.includes(`over v${TREE_VERSION}`))).toBe(true);
    expect(run.code).toBe(0);
  }, 300_000);
});

describe("the tagged source of a served client", () => {
  test("is fetched from origin when this checkout does not hold the tag, and a tag origin lacks names its cause", () => {
    const run = (cwd: string, command: readonly string[]): void => {
      const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
    };
    const origin = join(scratch, "origin");
    mkdirSync(origin);
    run(origin, ["git", "init", "--quiet"]);
    writeFileSync(join(origin, "package.json"), `${JSON.stringify({ name: "served", version: "9.9.9" })}\n`);
    run(origin, ["git", "add", "package.json"]);
    run(origin, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "release"]);
    run(origin, ["git", "tag", "v9.9.9"]);
    const clone = join(scratch, "clone");
    run(scratch, ["git", "clone", "--quiet", "--no-tags", origin, clone]);

    expect(materializeShippedSource("v9.9.9", clone)).toBe(join(scratch, "gate-home", "acceptance", "v9.9.9", "source"));
    expect(() => materializeShippedSource("v9.9.8", clone)).toThrow("the served client v9.9.8 is not tagged in this checkout, and origin did not provide the tag");
  }, 120_000);

  test("of a pre-public release comes from its source repository, never from the tag the public checkout holds", () => {
    const run = (cwd: string, command: readonly string[]): void => {
      const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
    };
    const tagged = (name: string, install: string): string => {
      const repository = join(scratch, name);
      mkdirSync(join(repository, "src", "orchestration", "update"), { recursive: true });
      run(scratch, ["git", "init", "--quiet", repository]);
      writeFileSync(join(repository, "package.json"), "{}\n");
      writeFileSync(join(repository, "src", "orchestration", "update", "update-install.ts"), install);
      run(repository, ["git", "add", "--all"]);
      run(repository, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", name]);
      run(repository, ["git", "tag", "v9.8.0"]);
      return repository;
    };
    const shippedInstall = "export const install = 1;\n";
    const development = tagged("development", shippedInstall);
    const snapshot = tagged("snapshot", "export const install = 2;\n");
    const prePublic = { tags: new Set(["v9.8.0"]), source: development };
    const notPrePublic = { tags: new Set<string>(), source: development };

    expect(updaterGeneration("v9.8.0", snapshot, prePublic)).toBe(updaterGeneration("v9.8.0", development, notPrePublic));
    expect(updaterGeneration("v9.8.0", snapshot, prePublic)).not.toBe(updaterGeneration("v9.8.0", snapshot, notPrePublic));
    const source = materializeShippedSource("v9.8.0", snapshot, prePublic);
    expect(readFileSync(join(source, "src", "orchestration", "update", "update-install.ts"), "utf8")).toBe(shippedInstall);
  }, 120_000);

  test("belongs to the updater generation that the import closure of the driven files makes, whatever else the tag changed", () => {
    const run = (cwd: string, command: readonly string[]): void => {
      const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
      if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
    };
    const repository = join(scratch, "generations");
    run(scratch, ["git", "init", "--quiet", repository]);
    const tag = (name: string, files: { readonly [path: string]: string }): void => {
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(join(repository, file, ".."), { recursive: true });
        writeFileSync(join(repository, file), content);
      }
      run(repository, ["git", "add", "--all"]);
      run(repository, ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", name]);
      run(repository, ["git", "tag", name]);
    };
    tag("v0.2.0", {
      "README.md": "first",
      "src/unrelated.ts": "export const unrelated = 1;\n",
      "src/orchestration/update/update-install.ts": 'import { confine } from "../../infra/descriptor-directory.js";\nexport const install = async () => (await import("./install-engine.js")).engine(confine);\n',
      "src/orchestration/update/install-engine.ts": "export const engine = (confine: number) => confine;\n",
      "src/infra/descriptor-directory.ts": "export const confine = 1;\n",
      "package.json": "{}\n",
    });
    tag("v0.2.1", { "README.md": "second", "src/unrelated.ts": "export const unrelated = 2;\n" });
    tag("v0.2.2", { "src/infra/descriptor-directory.ts": "export const confine = 2;\n" });
    tag("v0.2.3", { "src/orchestration/update/install-engine.ts": "export const engine = (confine: number) => confine + 1;\n" });
    tag("v0.2.4", { "package.json": '{ "dependencies": { "effect": "1.0.0" } }\n' });

    const [first, unrelated, imported, dynamicallyImported, locked] = ["v0.2.0", "v0.2.1", "v0.2.2", "v0.2.3", "v0.2.4"].map((name) => updaterGeneration(name, repository));
    expect(unrelated).toBe(first);
    expect(new Set([first, imported, dynamicallyImported, locked]).size).toBe(4);
  }, 120_000);
});
