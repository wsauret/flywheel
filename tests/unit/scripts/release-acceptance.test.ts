/** The release gate owns every restriction an installed client no longer
 *  applies: it refuses a staged release that breaks the release's own bounds,
 *  breaks a release contract later clients depend on, or that a served client
 *  refuses, and names the rule each time. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { gateRelease, type GateOptions, RELEASE_BOUNDS, releaseBoundViolations, type ShippedRunner, type StagedRelease } from "../../../scripts/release-acceptance.js";
import { releaseContractViolations, type VersionAnswer } from "../../../scripts/release-contract-checks.js";
import { computeBuildId } from "../../../src/infra/update/build-identity.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { fakeFetch } from "../../helpers/fake-fetch.js";
import { tarBlocks, type TarEntrySpec } from "../../helpers/tar-archive.js";

const temporaryDirectory = temporaryDirectories();
const ASSET = "flywheel-darwin-arm64.tar.gz";

/** A staged release of one archive, with whatever `release.json` states
 *  about it. */
function stage(entries: readonly TarEntrySpec[], manifest: (size: number) => object = (size) => ({ version: "0.2.0", assets: [{ name: ASSET, size }] })): StagedRelease {
  const dist = temporaryDirectory("flywheel-release-acceptance-");
  const archive = gzipSync(tarBlocks(entries));
  writeFileSync(join(dist, ASSET), archive);
  writeFileSync(join(dist, "release.json"), JSON.stringify(manifest(archive.byteLength)));
  return { dist, manifest: join(dist, "release.json"), repository: "acme/flywheel" };
}

const BUILD: readonly TarEntrySpec[] = [
  { name: "flywheel-darwin-arm64/build/", typeflag: "5", mode: 0o755 },
  { name: "flywheel-darwin-arm64/build/flywheel-bin", typeflag: "0", mode: 0o755, content: "binary" },
  { name: "flywheel-darwin-arm64/build/build.json", typeflag: "0", mode: 0o644, content: "{}" },
];

const accepting: ShippedRunner = async () => ({ accepted: true, lines: ["accepted darwin-arm64"] });

describe("the release's own bounds", () => {
  test("a release inside every bound breaks none", async () => {
    expect(await releaseBoundViolations(stage(BUILD))).toEqual([]);
  });

  test("an archive stated past the archive bound is refused by name, without reading a byte of it", async () => {
    const release = stage(BUILD, () => ({ version: "0.2.0", assets: [{ name: ASSET, size: 600 * 1024 * 1024 }] }));

    expect(await releaseBoundViolations(release)).toEqual([`${ASSET} states 629145600 bytes; the release bound for one archive is ${RELEASE_BOUNDS.archiveBytes}`]);
  });

  test("an archive whose bytes are not the size release.json states is refused", async () => {
    const release = stage(BUILD, (size) => ({ version: "0.2.0", assets: [{ name: ASSET, size: size + 1 }] }));

    expect(await releaseBoundViolations(release)).toEqual([expect.stringContaining("not the")]);
  });

  test("a release.json past its bound is refused", async () => {
    const release = stage(BUILD, (size) => ({ version: "0.2.0", padding: "x".repeat(RELEASE_BOUNDS.manifestBytes), assets: [{ name: ASSET, size }] }));

    expect(await releaseBoundViolations(release)).toEqual([expect.stringContaining("release.json is")]);
  });

  test("an archive that lists more entries, a larger extended header, or a larger build.json than the bounds is refused", async () => {
    const entries: TarEntrySpec[] = [...BUILD];
    for (let index = 0; index < RELEASE_BOUNDS.archiveEntries; index += 1) entries.push({ name: `flywheel-darwin-arm64/build/webview/${index}.js`, typeflag: "0", mode: 0o644 });
    entries.push({ name: "PaxHeaders/x", typeflag: "x", mode: 0o644, content: "y".repeat(RELEASE_BOUNDS.extendedHeaderBytes + 1) }, { name: "flywheel-darwin-arm64/build/build.json", typeflag: "0", mode: 0o644, content: "z".repeat(RELEASE_BOUNDS.metadataBytes + 1) });

    expect(await releaseBoundViolations(stage(entries))).toEqual([
      `${ASSET} lists entries: ${RELEASE_BOUNDS.archiveEntries + 4}; the release bound is ${RELEASE_BOUNDS.archiveEntries}`,
      `${ASSET} holds an extended header of bytes: ${RELEASE_BOUNDS.extendedHeaderBytes + 1}; the release bound is ${RELEASE_BOUNDS.extendedHeaderBytes}`,
      `${ASSET} holds a build.json of bytes: ${RELEASE_BOUNDS.metadataBytes + 1}; the release bound is ${RELEASE_BOUNDS.metadataBytes}`,
    ]);
  });
});

const NO_CONTRACTS = async (): Promise<readonly string[]> => [];

interface PublishedRelease {
  readonly tag: string;
  readonly draft?: boolean;
}

/** The public repository's release listing, newest first and in pages of
 *  100, as GitHub answers `GET /repos/<repo>/releases`. */
function publishing(releases: readonly PublishedRelease[]): typeof globalThis.fetch {
  return fakeFetch(async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/repos/acme/flywheel/releases") return new Response(null, { status: 404 });
    const page = Number(url.searchParams.get("page") ?? "1");
    const listed = releases.slice((page - 1) * 100, page * 100).map((release) => ({ tag_name: release.tag, draft: release.draft ?? false }));
    return Response.json(listed);
  });
}

/** A gate whose served clients are `published`, each its own updater
 *  generation unless `generationOf` groups them. */
function served(published: readonly PublishedRelease[], options: GateOptions = {}): GateOptions {
  return { checkContracts: NO_CONTRACTS, fetch: publishing(published), generationOf: (tag) => tag, ...options };
}

describe("the served clients' acceptance", () => {
  test("a release every served client accepts passes the gate", async () => {
    expect((await gateRelease(stage(BUILD), served([{ tag: "v0.1.0" }], { runShipped: accepting }))).violations).toEqual([]);
  });

  test("a rule a served client refuses fails the gate with that client's own words", async () => {
    const refusing: ShippedRunner = async () => ({ accepted: false, lines: ["accepted darwin-arm64", "refused win32-x64: The archive is not safe to extract: an entry of type \"symbolic link\" is not a regular file or a directory"] });

    expect((await gateRelease(stage(BUILD), served([{ tag: "v0.1.0" }], { runShipped: refusing }))).violations).toEqual(["v0.1.0 client refused win32-x64: The archive is not safe to extract: an entry of type \"symbolic link\" is not a regular file or a directory"]);
  });

  test("a served client that fails without naming a rule still fails the gate", async () => {
    const crashing: ShippedRunner = async () => ({ accepted: false, lines: [] });

    expect((await gateRelease(stage(BUILD), served([{ tag: "v0.1.0" }], { runShipped: crashing }))).violations).toEqual(["v0.1.0 client refused the release without naming a rule: no output"]);
  });

  test("the served clients are the published releases from v0.1.0 on, never a draft or the release itself, each updater generation run once on its oldest tag", async () => {
    const ran: string[] = [];
    const recording: ShippedRunner = async (tag) => { ran.push(tag); return { accepted: true, lines: [] }; };
    // A full first page, so the listing is read past it.
    const filler = Array.from({ length: 100 }, (_unused, index) => ({ tag: `v0.1.${109 - index}` }));
    const published = [{ tag: "v0.2.0" }, ...filler, { tag: "v0.1.2", draft: true }, { tag: "v0.1.0" }, { tag: "v0.0.9" }];

    const gate = await gateRelease(stage(BUILD), served(published, { runShipped: recording, generationOf: (tag) => (tag === "v0.1.0" || tag === "v0.1.11" ? "first" : "second") }));

    expect(gate.served).toEqual(["v0.1.0", ...Array.from({ length: 100 }, (_unused, index) => `v0.1.${10 + index}`)]);
    expect(ran).toEqual(["v0.1.0", "v0.1.10"]);
    expect(gate.violations).toEqual([]);
  });

  test("a listing that cannot be read fails the gate rather than serving no client", async () => {
    const failing = fakeFetch(async () => new Response(null, { status: 502 }));

    await expect(gateRelease(stage(BUILD), served([], { runShipped: accepting, fetch: failing }))).rejects.toThrow("HTTP 502");
  });

  test("a release outside its own bounds or its contracts is refused before any served client runs", async () => {
    let runs = 0;
    const counting: ShippedRunner = async () => { runs += 1; return { accepted: true, lines: [] }; };

    const outside = await gateRelease(stage(BUILD, () => ({ version: "0.2.0", assets: [{ name: ASSET, size: 600 * 1024 * 1024 }] })), served([{ tag: "v0.1.0" }], { runShipped: counting }));
    const broken = await gateRelease(stage(BUILD), served([{ tag: "v0.1.0" }], { runShipped: counting, checkContracts: async () => ["a contract"] }));

    expect(outside.violations).toHaveLength(1);
    expect(broken.violations).toEqual(["a contract"]);
    expect(runs).toBe(0);
  });
});

// --- the release contracts ----------------------------------------------------

const HOST = { platformArch: "darwin-arm64", platform: "darwin" } as const;
const WINDOWS = { platformArch: "win32-x64", platform: "win32" } as const;

interface ContractBuild {
  readonly target: { readonly platformArch: string; readonly platform: string };
  readonly version?: string;
  readonly buildId?: string;
  readonly executableMode?: number;
  readonly launchers?: boolean;
}

/** One target's archive as the release build writes it, with whatever the
 *  case under test breaks. */
function contractArchive(dist: string, build: ContractBuild): void {
  const { platformArch, platform } = build.target;
  const tree = temporaryDirectory("flywheel-contract-build-");
  const executable = platform === "win32" ? "flywheel-bin.exe" : "flywheel-bin";
  const files: { readonly path: string; readonly mode: number; readonly content: string }[] = [
    { path: executable, mode: build.executableMode ?? 0o755, content: "binary" },
    ...(platform === "win32" && build.launchers !== false
      ? [{ path: `native/${platformArch}/flywheel-launcher.exe`, mode: 0o755, content: "launcher" }, { path: `native/${platformArch}/flywheel-service-launcher.exe`, mode: 0o755, content: "service" }]
      : []),
  ];
  for (const file of files) {
    mkdirSync(join(tree, file.path, ".."), { recursive: true });
    writeFileSync(join(tree, file.path), file.content);
    chmodSync(join(tree, file.path), file.mode);
  }
  const buildId = build.buildId ?? computeBuildId(tree, platform);
  const root = `flywheel-${platformArch}/build`;
  writeFileSync(join(dist, `flywheel-${platformArch}.tar.gz`), gzipSync(tarBlocks([
    ...files.map((file): TarEntrySpec => ({ name: `${root}/${file.path}`, typeflag: "0", mode: file.mode, content: file.content })),
    { name: `${root}/build.json`, typeflag: "0", mode: 0o644, content: JSON.stringify({ version: build.version ?? "0.2.0", buildId }) },
  ])));
}

function contractRelease(builds: readonly ContractBuild[], version = "0.2.0") {
  const dist = temporaryDirectory("flywheel-contract-release-");
  for (const build of builds) contractArchive(dist, build);
  const manifest = join(dist, "release.json");
  writeFileSync(manifest, JSON.stringify({ version, assets: builds.map((build) => ({ name: `flywheel-${build.target.platformArch}.tar.gz` })) }));
  return { dist, manifest };
}

/** The contracts of a release whose host build gives `answer` when it is
 *  asked its version. */
function contracts(release: ReturnType<typeof contractRelease>, answer: VersionAnswer = { kind: "exited", code: 0 }) {
  return releaseContractViolations(release, { targets: [HOST, WINDOWS], host: HOST.platformArch, runVersion: () => answer });
}

describe.skipIf(process.platform === "win32")("the release contracts later clients depend on", () => {
  test("a release that keeps every contract breaks none", async () => {
    expect(await contracts(contractRelease([{ target: HOST }, { target: WINDOWS }]))).toEqual([]);
  });

  test("a target the release does not publish is refused by its asset name", async () => {
    expect(await contracts(contractRelease([{ target: HOST }]))).toEqual(["release.json publishes no flywheel-win32-x64.tar.gz, the only archive a client on win32-x64 asks for"]);
  });

  test("a version that is not strict major.minor.patch is refused before any archive is read", async () => {
    expect(await contracts(contractRelease([{ target: HOST }, { target: WINDOWS }], "2027.1"))).toEqual([expect.stringContaining("is not a strict major.minor.patch release")]);
  });

  test("a build.json that names another version or a build id that is not the tree's 64-digit digest is refused", async () => {
    expect(await contracts(contractRelease([{ target: HOST, version: "0.1.9" }, { target: WINDOWS, buildId: "build-7" }]))).toEqual([
      "flywheel-darwin-arm64.tar.gz holds a build.json whose version is \"0.1.9\", not the release's 0.2.0",
      "flywheel-win32-x64.tar.gz holds a build.json whose buildId \"build-7\" is not a 64-digit hexadecimal digest, the only form a running build registers under",
    ]);
    expect(await contracts(contractRelease([{ target: HOST, buildId: "a".repeat(64) }, { target: WINDOWS }]))).toEqual([`flywheel-darwin-arm64.tar.gz holds a build that does not digest to the buildId ${"a".repeat(64)} its build.json states`]);
  });

  test("a build with no executable, or a Windows build with no launchers, is refused", async () => {
    expect(await contracts(contractRelease([{ target: HOST, executableMode: 0o644 }, { target: WINDOWS, launchers: false }]))).toEqual([
      "flywheel-darwin-arm64.tar.gz holds no executable flywheel-bin",
      "flywheel-win32-x64.tar.gz carries no Windows launcher native/win32-x64/flywheel-launcher.exe",
      "flywheel-win32-x64.tar.gz carries no Windows launcher native/win32-x64/flywheel-service-launcher.exe",
    ]);
  });

  test("a host build that does not exit 0 when it is asked its version is refused", async () => {
    const release = contractRelease([{ target: HOST }, { target: WINDOWS }]);

    expect(await contracts(release, { kind: "exited", code: 134 })).toEqual(["flywheel-darwin-arm64.tar.gz holds a build that exited 134 when it was asked --version"]);
    expect(await contracts(release, { kind: "killed", signal: "SIGSEGV" })).toEqual(["flywheel-darwin-arm64.tar.gz holds a build that was killed by SIGSEGV when it was asked --version"]);
    expect(await contracts(release, { kind: "no answer" })).toEqual(["flywheel-darwin-arm64.tar.gz holds a build that did not answer --version within 30000ms"]);
  });

  test("an archive no client can place is refused", async () => {
    const release = contractRelease([{ target: HOST }, { target: WINDOWS }]);
    writeFileSync(join(release.dist, "flywheel-win32-x64.tar.gz"), "not gzip");

    expect(await contracts(release)).toEqual([expect.stringMatching(/^flywheel-win32-x64\.tar\.gz is not an archive a client can place: /)]);
  });
});
