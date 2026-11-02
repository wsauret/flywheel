/** The bootstrap installers are the first code a new user runs, and they run
 *  it against the open internet. These properties are proved here against a
 *  real release server and real `curl` and `tar`:
 *
 *  - `latest` is resolved exactly once. A release published between the
 *    resolution and the payload requests cannot mix two releases into one
 *    installation, because every later request names the tag that was resolved.
 *  - An unsafe archive is refused before extraction changes anything. The
 *    corpus below is the one both installers face, and it is the corpus
 *    src/infra/update/archive-entry.ts states: a dot component, an empty
 *    component, a backslash, an absolute name, a repeated path, a link, a
 *    device, and a FIFO.
 *  - Every bound is a refusal and not a download: the request deadline, the
 *    compressed byte cap, the entry count, one file, and the whole tree.
 *
 *  The Unix script is executed. The PowerShell script is executed when a
 *  PowerShell is installed, and is otherwise held to the same contract by
 *  reading it: this host has no PowerShell. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statedMessage } from "./powershell-output.js";
import { ASSET, ROOT, WINDOWS_ROOT, WINDOWS_ASSET, buildArchive, tarball, payloadEntries, windowsPayloadEntries, admissionCorpus } from "./bootstrap-archive-fixture.js";

const REPO = "acme/flywheel";
const INSTALL_SH_SOURCE = join(import.meta.dir, "..", "..", "..", "install.sh");
const INSTALL_PS1_SOURCE = join(import.meta.dir, "..", "..", "..", "install.ps1");

let workspace: string;
let server: ReturnType<typeof Bun.serve>;
/** The second release server. It answers on another authority, so a hop to a
 *  host the installer may follow and a hop to a host it may not are told apart
 *  by the authority it is configured with, and not by DNS. */
let assetServer: ReturnType<typeof Bun.serve>;
let origin: string;
let assetOrigin: string;
let installSh: string;
let installPs1: string;
/** Every path the release servers were asked for, in order. A hop that must be
 *  refused before it is requested is proved by its absence from this. */
const requested: string[] = [];
/** What a server answers with instead of the release a path names, by path. */
const redirects = new Map<string, string>();
/** A body larger than any cap a test shrinks a script to. */
const OVERSIZED_BYTES = 262144;
/** Every tag the server publishes: the bytes it answers with, and the bytes
 *  whose digest SHASUMS256.txt states. They differ only for a tampered
 *  download. */
const releases = new Map<string, { served: Uint8Array; stated: Uint8Array }>();

function publish(tag: string, served: Uint8Array, stated: Uint8Array = served): void {
  releases.set(tag, { served, stated });
}

/** The tag whose asset answers and then sends nothing. */
const STALL_TAG = "v5.5.5";
/** What `latest` resolves to. Moved by the test between two requests. */
let latestTag = "v1.0.0";

/** Spawned rather than run synchronously: the release server below answers on
 *  this thread, so a blocking child would deadlock against its own downloads. */
async function run(command: readonly string[], env: { [key: string]: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** One tag serves one archive under either asset name, so a Windows run and a
 *  Unix run face the same bytes and the same stated digest. */
function checksums(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${digest}  ${ASSET}\n${digest}  ${WINDOWS_ASSET}\n`;
}

/** One release server, answering on two authorities. `requested` records what
 *  it was asked for, and `redirects` states which of those it answers with a
 *  hop instead of a release. */
function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  requested.push(pathname);
  const redirect = redirects.get(pathname);
  if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
  if (pathname === "/oversized/stated") {
    const bytes = new Uint8Array(OVERSIZED_BYTES);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  }
  if (pathname === "/oversized/hidden") {
    // No length: a chunked stream states its size only by ending, so the cap
    // holds only if the installer counts what arrives.
    return new Response(new ReadableStream({
      start(controller) {
        for (let sent = 0; sent < OVERSIZED_BYTES; sent += 8192) controller.enqueue(new Uint8Array(8192));
        controller.close();
      },
    }));
  }
  if (pathname === `/${REPO}/releases/latest`) {
    const target = `/${REPO}/releases/tag/${latestTag}`;
    // Resolution and payload requests are separate: the tag moves here, so
    // an installer that re-resolved would install the other release.
    latestTag = "v2.0.0";
    return new Response(null, { status: 302, headers: { location: target } });
  }
  if (pathname.startsWith(`/${REPO}/releases/tag/`)) return new Response("release page");
  const hosted = /^\/(?:(.+)\/releases\/download|asset)\/(v[^/]+)\/(.+)$/.exec(pathname);
  if (hosted && (hosted[1] === REPO || hosted[1] === undefined)) {
    const release = releases.get(hosted[2] ?? "");
    if (!release) return new Response("no such release", { status: 404 });
    if (hosted[3] === ASSET || hosted[3] === WINDOWS_ASSET) {
      // Answers, then sends nothing. Only the request deadline ends this.
      if (hosted[2] === STALL_TAG) return new Response(new ReadableStream({ start() {} }));
      // A copy, so the body is typed over a plain ArrayBuffer as Response requires.
      return new Response(release.served.slice());
    }
    if (hosted[3] === "SHASUMS256.txt") return new Response(checksums(release.stated));
  }
  return new Response("not found", { status: 404 });
}

/** The bootstrap script under test, pointed at the local release servers. An
 *  `edit` shrinks one stated bound, so a refusal is proved without moving half
 *  a gigabyte. The origin and the asset authorities are what the shipped script
 *  states and nothing else, so what a test rewrites is exactly the origin the
 *  installer holds every hop to. */
function bootstrapScript(fileName: string, edit: (source: string) => string = (source) => source): string {
  const path = join(workspace, fileName);
  writeFileSync(path, edit(readFileSync(INSTALL_SH_SOURCE, "utf-8")
    .replace('ORIGIN_SCHEME="https"', () => 'ORIGIN_SCHEME="http"')
    .replace('ORIGIN_AUTHORITY="github.com"', () => `ORIGIN_AUTHORITY="127.0.0.1:${server.port}"`)
    .replace(/^ASSET_AUTHORITIES=.*$/m, () => `ASSET_AUTHORITIES="127.0.0.1:${assetServer.port}"`)));
  return path;
}

function windowsScript(fileName: string, edit: (source: string) => string = (source) => source): string {
  const path = join(workspace, fileName);
  writeFileSync(path, edit(readFileSync(INSTALL_PS1_SOURCE, "utf-8")
    .replace('$OriginScheme = "https"', () => '$OriginScheme = "http"')
    .replace('$OriginAuthority = "github.com"', () => `$OriginAuthority = "127.0.0.1:${server.port}"`)
    .replace(/^\$AssetAuthorities = .*$/m, () => `$AssetAuthorities = @("127.0.0.1:${assetServer.port}")`)));
  return path;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "flywheel-bootstrap-"));
  publish("v1.0.0", buildArchive("v1.0.0"));
  publish("v2.0.0", buildArchive("v2.0.0"));

  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  assetServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  origin = `http://127.0.0.1:${server.port}`;
  assetOrigin = `http://127.0.0.1:${assetServer.port}`;
  installSh = bootstrapScript("install.sh");
  installPs1 = windowsScript("install.ps1");
});

afterAll(() => {
  server.stop(true);
  assetServer.stop(true);
  rmSync(workspace, { recursive: true, force: true });
});

function bootstrapEnv(marker: string) {
  return {
    HOME: workspace,
    FLYWHEEL_INSTALL_DIR: join(workspace, "bin"),
    FLYWHEEL_REPO: REPO,
    FLYWHEEL_VERSION: "latest",
    FLYWHEEL_TEST_MARKER: marker,
  };
}

/** A hop a release server states, and the refusal it must earn. Both
 *  installers judge a hop before they request it, so a hop that leaves the
 *  releases of the configured repository, names another port, downgrades the
 *  scheme, carries credentials, or holds a dot segment is refused by both. The
 *  location is built when the test runs, because it names the port the release
 *  server was given. */
const REFUSED_HOPS: readonly (readonly [string, (originUrl: string, port: number | undefined) => string, RegExp])[] = [
  ["a path outside the releases of the repository", (originUrl) => `${originUrl}/planted/evil.tar.gz`, /outside the releases of/],
  ["another port on the origin host", () => `http://127.0.0.1:1/${REPO}/releases/download/v6.7.0/planted.tar.gz`, /host is not one this install may request/],
  ["another scheme", (_originUrl, port) => `https://127.0.0.1:${port}/${REPO}/releases/download/v6.7.0/planted.tar.gz`, /which is not http/],
  ["credentials", (_originUrl, port) => `http://someone:secret@127.0.0.1:${port}/${REPO}/releases/download/v6.7.0/planted.tar.gz`, /carries credentials/],
  ["a dot segment", (originUrl) => `${originUrl}/${REPO}/releases/download/../../planted/evil.tar.gz`, /holds a dot segment|outside the releases of/],
];

/** The download of one tag, answered with a hop instead of the release. */
function statePayloadHop(tag: string, asset: string, location: string): void {
  redirects.set(`/${REPO}/releases/download/${tag}/${asset}`, location);
}

/** A chain of hops that is longer than either installer allows. */
function stateHopChain(tag: string, asset: string): void {
  statePayloadHop(tag, asset, `${assetOrigin}/hop/1`);
  for (let step = 1; step <= 8; step += 1) redirects.set(`/hop/${step}`, `${assetOrigin}/hop/${step + 1}`);
}

/** The one detection of the platform, the architecture, and the C library.
 *  Each case runs the real script with `uname`, `sysctl`, and `ldd` answered
 *  by stubs, and the archive it asks the release server for is the archive it
 *  selected. A selection other than this host's own finds no archive and
 *  stops there, which is all a case needs. */
describe.skipIf(process.platform === "win32")("the Unix bootstrap installer's platform selection", () => {
  const MISSING = "/nonexistent/flywheel-test";

  function stubs(): string {
    const dir = mkdtempSync(join(workspace, "stubs-"));
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    stub("uname", 'case "$1" in -s) echo "$STUB_OS" ;; -m) echo "$STUB_MACHINE" ;; *) echo "$STUB_OS" ;; esac');
    stub("sysctl", '[ -n "$STUB_TRANSLATED" ] || { echo "sysctl: unknown oid" >&2; exit 1; }\necho "$STUB_TRANSLATED"');
    stub("ldd", 'echo "$STUB_LDD" >&2\n[ "$STUB_LDD" = "musl libc (x86_64)" ] && exit 1\nexit 0');
    return dir;
  }

  interface Host { readonly os: string; readonly machine: string; readonly translated?: string; readonly ldd?: string; readonly alpineRelease?: boolean; readonly cxxRuntime?: boolean }

  async function select(host: Host): Promise<{ readonly exitCode: number; readonly stderr: string; readonly assets: readonly string[] }> {
    const present = join(workspace, "present-file");
    writeFileSync(present, "3.22.0\n");
    const script = bootstrapScript(`install-select-${crypto.randomUUID()}.sh`, (source) => source
      .replace(/^ALPINE_RELEASE=.*$/m, () => `ALPINE_RELEASE="${host.alpineRelease ? present : MISSING}"`)
      .replace(/^MUSL_CXX_RUNTIMES=.*$/m, () => `MUSL_CXX_RUNTIMES="${MISSING} ${host.cxxRuntime === false ? MISSING : present}"`));
    const before = requested.length;
    const result = await run(["sh", script], {
      ...bootstrapEnv(join(workspace, `select-marker-${crypto.randomUUID()}`)),
      FLYWHEEL_VERSION: "v1.0.0",
      PATH: `${stubs()}:${process.env.PATH ?? ""}`,
      STUB_OS: host.os,
      STUB_MACHINE: host.machine,
      STUB_TRANSLATED: host.translated ?? "",
      STUB_LDD: host.ldd ?? "ldd (GNU libc) 2.39",
    });
    const prefix = `/${REPO}/releases/download/v1.0.0/`;
    const assets = requested.slice(before).filter((path) => path.startsWith(prefix) && path.endsWith(".tar.gz")).map((path) => path.slice(prefix.length));
    return { exitCode: result.exitCode, stderr: result.stderr, assets };
  }

  test.each([
    ["an Apple silicon Mac", { os: "Darwin", machine: "arm64" }, "flywheel-darwin-arm64.tar.gz"],
    ["an Intel Mac", { os: "Darwin", machine: "x86_64" }, "flywheel-darwin-x64.tar.gz"],
    ["a shell Rosetta translates on Apple silicon", { os: "Darwin", machine: "x86_64", translated: "1" }, "flywheel-darwin-arm64.tar.gz"],
    ["a glibc Linux on x64", { os: "Linux", machine: "x86_64" }, "flywheel-linux-x64.tar.gz"],
    ["a glibc Linux on ARM64", { os: "Linux", machine: "aarch64" }, "flywheel-linux-arm64.tar.gz"],
    ["a musl Linux that ldd names", { os: "Linux", machine: "x86_64", ldd: "musl libc (x86_64)" }, "flywheel-linux-x64-musl.tar.gz"],
    ["an Alpine Linux on ARM64", { os: "Linux", machine: "aarch64", alpineRelease: true }, "flywheel-linux-arm64-musl.tar.gz"],
  ] as const)("selects the archive for %s", async (_name, host, expected) => {
    const { assets } = await select(host);
    expect(assets).toEqual([expected]);
  });

  test("refuses a musl Linux with no C++ runtime before it downloads anything", async () => {
    const { exitCode, stderr, assets } = await select({ os: "Linux", machine: "x86_64", alpineRelease: true, cxxRuntime: false });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("apk add libstdc++");
    expect(assets).toEqual([]);
  });
});

/** `install.sh` refuses to run on Windows and names `install.ps1` instead, so
 *  the contract below is only observable where a Unix installation is possible.
 *  What both installers must state alike is proved by the corpus comparison at
 *  the end of this file, which runs on either platform. */
describe.skipIf(process.platform === "win32")("the Unix bootstrap installer", () => {
  const pins: {
    name: string;
    pin: string;
    active: string;
    admitted: boolean;
    layout?: "absent" | "outside" | "nested" | "missing" | "malformed" | "version-mismatch" | "build-mismatch" | "linked-account" | "changed-payload";
  }[] = [
    { name: "v-prefixed older minor", pin: "v0.9.0", active: "0.10.0", admitted: false },
    { name: "bare older minor", pin: "0.9.0", active: "0.10.0", admitted: false },
    { name: "older patch", pin: "v0.10.0", active: "0.10.1", admitted: false },
    { name: "older major", pin: "v1.99.99", active: "2.0.0", admitted: false },
    { name: "equal version", pin: "v0.10.0", active: "0.10.0", admitted: true },
    { name: "newer minor", pin: "0.10.0", active: "0.9.0", admitted: true },
    { name: "newer patch", pin: "v0.10.1", active: "0.10.0", admitted: true },
    { name: "newer major", pin: "v1.0.0", active: "0.10.0", admitted: true },
    { name: "latest remains engine-owned", pin: "latest", active: "0.10.0", admitted: true },
    { name: "no current", pin: "v0.9.0", active: "0.10.0", layout: "absent", admitted: true },
    { name: "outside versions root", pin: "v0.9.0", active: "0.10.0", layout: "outside", admitted: true },
    { name: "extra directory component", pin: "v0.9.0", active: "0.10.0", layout: "nested", admitted: true },
    { name: "missing metadata", pin: "v0.9.0", active: "0.10.0", layout: "missing", admitted: true },
    { name: "malformed metadata", pin: "v0.9.0", active: "0.10.0", layout: "malformed", admitted: true },
    { name: "metadata names another version", pin: "v0.9.0", active: "0.10.0", layout: "version-mismatch", admitted: true },
    { name: "metadata names another build", pin: "v0.9.0", active: "0.10.0", layout: "build-mismatch", admitted: true },
    { name: "noncanonical active version", pin: "v0.9.0", active: "00.10.0", admitted: true },
    { name: "physical account root", pin: "v0.9.0", active: "0.10.0", layout: "linked-account", admitted: false },
    { name: "changed old payload", pin: "v0.10.1", active: "0.10.0", layout: "changed-payload", admitted: true },
  ];

  test.each(pins)("explicit pin preflight: $name", async (scenario) => {
    const home = mkdtempSync(join(workspace, "pin-"));
    const account = join(home, ".flywheel");
    const layout = scenario.layout ?? "canonical";
    if (layout === "linked-account") {
      mkdirSync(join(home, "physical-account"));
      symlinkSync("physical-account", account);
    }
    const versions = join(account, "versions");
    mkdirSync(versions, { recursive: true });
    const buildId = "a".repeat(64);
    const build = join(layout === "outside" ? home : versions, ...(layout === "nested" ? ["extra"] : []), scenario.active, buildId);
    mkdirSync(build, { recursive: true });
    const metadata = {
      version: layout === "version-mismatch" ? "0.11.0" : scenario.active,
      buildId: layout === "build-mismatch" ? "b".repeat(64) : buildId,
      asset: ASSET,
    };
    if (layout !== "missing") writeFileSync(join(build, "build.json"), layout === "malformed" ? `{\n  "version": "${scenario.active}",\n` : JSON.stringify(metadata, null, 2));
    writeFileSync(join(build, "flywheel-bin"), layout === "changed-payload" ? "changed old bytes" : "old payload");
    const current = join(account, "current");
    if (layout !== "absent") symlinkSync(build, current);
    const bin = join(home, "bin");
    mkdirSync(bin);
    const launcher = join(bin, "flywheel");
    writeFileSync(launcher, '#!/bin/sh\nprintf executed > "$FLYWHEEL_TEST_LAUNCHER_MARKER"\nexit 1\n');
    chmodSync(launcher, 0o755);
    const savedFiles = [launcher, join(account, "flywheel.toml"), join(account, "auth.json"), join(build, "flywheel-bin")];
    for (const file of savedFiles.slice(1, 3)) writeFileSync(file, "saved-state sentinel\n");
    const before = savedFiles.map((file) => readFileSync(file, "utf8"));
    const beforeCurrent = layout === "absent" ? undefined : readlinkSync(current);
    const marker = join(home, "archive-ran");
    const launcherMarker = join(home, "launcher-ran");
    const tag = scenario.pin === "latest" ? "v0.9.0" : `v${scenario.pin.replace(/^v/, "")}`;
    latestTag = tag;
    publish(tag, tarball(payloadEntries(tag)));
    requested.length = 0;

    const result = await run(["sh", installSh], {
      ...bootstrapEnv(marker), HOME: home, FLYWHEEL_INSTALL_DIR: bin,
      FLYWHEEL_VERSION: scenario.pin, FLYWHEEL_TEST_LAUNCHER_MARKER: launcherMarker,
    });

    expect(savedFiles.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    expect(layout === "absent" ? existsSync(current) : readlinkSync(current)).toBe(beforeCurrent ?? false);
    expect(existsSync(launcherMarker)).toBe(false);
    if (scenario.admitted) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(requested).toContain(`/${REPO}/releases/download/${tag}/${ASSET}`);
      expect(readFileSync(marker, "utf8")).toBe(tag);
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`requested version ${tag.slice(1)} is older than active version ${scenario.active}`);
      expect(result.stderr).toContain("this installer does not downgrade");
      expect(result.stderr).toContain(`published version newer than ${scenario.active}`);
      expect(result.stderr).toContain("FLYWHEEL_VERSION set to it");
      expect(result.stderr).toContain("If none exists, wait for a newer release");
      expect(result.stderr).not.toContain("FLYWHEEL_VERSION=latest");
      expect(result.stderr).not.toMatch(/rm |remove|delete|ln -s/);
      expect(requested).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    }
  });

  test("resolves latest once and installs the release that resolution selected", async () => {
    latestTag = "v1.0.0";
    const marker = join(workspace, "installed-tag");
    const observed = bootstrapScript("observed.sh", (source) => source.replace('rm -rf "$tmp_dir"', 'rm -rf "$tmp_dir"\n  printf "cleanup finished\\n"'));
    const result = await run(["sh", observed], bootstrapEnv(marker));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Installing flywheel version: 1.0.0");
    expect(result.stdout).toContain("cleanup finished\n\nFlywheel installed");
    expect(result.stdout).not.toContain("\x1b");
    expect(readFileSync(marker, "utf-8")).toBe("v1.0.0");
  });

  const corpus: readonly (readonly [string, (rootDir: string) => void])[] = [
    ["a symlink", (rootDir) => { symlinkSync("/etc/passwd", join(rootDir, "build", "link")); }],
    ["a hard link", (rootDir) => { linkSync(join(rootDir, "build", "flywheel-bin"), join(rootDir, "build", "second-name")); }],
    ["a FIFO", (rootDir) => { Bun.spawnSync(["mkfifo", join(rootDir, "build", "pipe")], { stdout: "pipe", stderr: "pipe", windowsHide: true }); }],
  ];

  test.each(corpus)("refuses an archive holding %s, and installs nothing", async (name, customizeArchive) => {
    latestTag = "v9.9.9";
    publish("v9.9.9", buildArchive("v9.9.9", customizeArchive));
    const marker = join(workspace, `refused-${name.replaceAll(" ", "-")}`);

    const result = await run(["sh", installSh], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("flywheel install:");
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses an archive whose entries are absolute or leave the archive root, and installs nothing", async () => {
    const stage = mkdtempSync(join(tmpdir(), "flywheel-archive-"));
    try {
      const outside = join(stage, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "evil"), "planted");
      const archive = join(stage, ASSET);
      const tar = Bun.spawnSync(["tar", "-czPf", archive, join(outside, "evil")], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      expect(tar.exitCode).toBe(0);

      latestTag = "v8.8.8";
      publish("v8.8.8", new Uint8Array(readFileSync(archive)));
      const marker = join(workspace, "refused-absolute");

      const result = await run(["sh", installSh], bootstrapEnv(marker));

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("flywheel install:");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("refuses an archive whose bytes are not the ones the release states", async () => {
    const original = buildArchive("v7.7.7");
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    publish("v7.7.7", tampered, original);
    latestTag = "v7.7.7";
    const marker = join(workspace, "refused-checksum");

    const result = await run(["sh", installSh], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(marker)).toBe(false);
  });

  test("installs a hand-written archive, so the corpus below differs by one entry only", async () => {
    latestTag = "v6.0.0";
    publish("v6.0.0", tarball(payloadEntries("v6.0.0")));
    const marker = join(workspace, "hand-written-tag");

    const result = await run(["sh", installSh], bootstrapEnv(marker));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("v6.0.0");
  });

  test.each(admissionCorpus(ROOT))("refuses a hand-written archive holding %s, and installs nothing", async (name, extra, reason) => {
    latestTag = "v6.1.0";
    publish("v6.1.0", tarball([...payloadEntries("v6.1.0"), extra]));
    const marker = join(workspace, `refused-corpus-${name.replaceAll(" ", "-")}`);

    const result = await run(["sh", installSh], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(reason);
    expect(existsSync(marker)).toBe(false);
  });

  const bounds: readonly (readonly [string, string, string, string])[] = [
    ["the entry count", "MAX_ENTRIES=4096", "MAX_ENTRIES=2", "more than the 2 allowed"],
    ["one file", "MAX_FILE_BYTES=536870912", "MAX_FILE_BYTES=4", "allowed for one file"],
    ["the whole tree", "MAX_TOTAL_BYTES=1073741824", "MAX_TOTAL_BYTES=8", "bytes allowed for one archive"],
  ];

  test.each(bounds)("refuses an archive over the bound on %s, before it extracts anything", async (name, stated, shrunk, message) => {
    latestTag = "v6.2.0";
    publish("v6.2.0", tarball(payloadEntries("v6.2.0")));
    const script = bootstrapScript(`bounded-${name.replaceAll(" ", "-")}.sh`, (source) => source.replace(stated, shrunk));
    const marker = join(workspace, `refused-bound-${name.replaceAll(" ", "-")}`);

    const result = await run(["sh", script], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses a download over the compressed byte cap", async () => {
    latestTag = "v6.3.0";
    publish("v6.3.0", tarball(payloadEntries("v6.3.0")));
    const script = bootstrapScript("capped.sh", (source) => source.replace("MAX_ARCHIVE_BYTES=536870912", "MAX_ARCHIVE_BYTES=64"));
    const marker = join(workspace, "refused-cap");

    const result = await run(["sh", script], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not be downloaded from");
    expect(existsSync(marker)).toBe(false);
  });

  test("counts the bytes itself when curl does not enforce the cap", async () => {
    latestTag = "v6.4.0";
    publish("v6.4.0", tarball(payloadEntries("v6.4.0")));
    // `--max-filesize 0` is curl's word for no limit, so this run is the one
    // where only the script's own count stands between the cap and extraction.
    const script = bootstrapScript("uncapped-curl.sh", (source) =>
      source
        .replace("MAX_ARCHIVE_BYTES=536870912", "MAX_ARCHIVE_BYTES=64")
        .replace('--max-filesize "$fetch_max_bytes"', "--max-filesize 0"));
    const marker = join(workspace, "refused-counted-cap");

    const result = await run(["sh", script], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("more than the 64 allowed");
    expect(existsSync(marker)).toBe(false);
  });

  test("ends a download that answers and then sends nothing", async () => {
    latestTag = STALL_TAG;
    publish(STALL_TAG, tarball(payloadEntries(STALL_TAG)));
    const script = bootstrapScript("bounded-request.sh", (source) => source.replace("MAX_TIME=600", "MAX_TIME=2"));
    const marker = join(workspace, "refused-stall");

    const startedAt = Date.now();
    const result = await run(["sh", script], bootstrapEnv(marker));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not be downloaded from");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("follows a chain of hops to the approved release-asset host", async () => {
    const tag = "v6.7.0";
    latestTag = tag;
    publish(tag, tarball(payloadEntries(tag)));
    statePayloadHop(tag, ASSET, `${assetOrigin}/hop/1`);
    redirects.set("/hop/1", `${assetOrigin}/asset/${tag}/${ASSET}`);
    requested.length = 0;
    const marker = join(workspace, "hopped-tag");

    try {
      const result = await run(["sh", installSh], bootstrapEnv(marker));

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe(tag);
      expect(requested).toContain("/hop/1");
      expect(requested).toContain(`/asset/${tag}/${ASSET}`);
    } finally {
      redirects.clear();
    }
  });

  test.each(REFUSED_HOPS)("refuses a hop that names %s, and never requests it", async (name, location, reason) => {
    const tag = "v6.7.0";
    latestTag = tag;
    publish(tag, tarball(payloadEntries(tag)));
    statePayloadHop(tag, ASSET, location(origin, server.port));
    requested.length = 0;
    const marker = join(workspace, `refused-hop-${name.replaceAll(" ", "-")}`);

    try {
      const result = await run(["sh", installSh], bootstrapEnv(marker));

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(reason);
      expect(requested.filter((path) => path.includes("planted"))).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      redirects.clear();
    }
  });

  test("refuses a chain of hops longer than it allows", async () => {
    const tag = "v6.7.0";
    latestTag = tag;
    publish(tag, tarball(payloadEntries(tag)));
    stateHopChain(tag, ASSET);
    requested.length = 0;
    const marker = join(workspace, "refused-hop-chain");

    try {
      const result = await run(["sh", installSh], bootstrapEnv(marker));

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("redirected more than the 5 times allowed");
      expect(requested.filter((path) => path.startsWith("/hop/")).length).toBeLessThanOrEqual(5);
      expect(existsSync(marker)).toBe(false);
    } finally {
      redirects.clear();
    }
  });

  const oversized: readonly (readonly [string, string, RegExp])[] = [
    ["states a length over the cap", "/oversized/stated", /could not be downloaded from/],
    ["hides its length behind a chunked stream", "/oversized/hidden", /could not be downloaded from|more than the 4096 allowed/],
  ];

  test.each(oversized)("refuses a body that %s", async (name, path, reason) => {
    const tag = "v6.8.0";
    latestTag = tag;
    publish(tag, tarball(payloadEntries(tag)));
    statePayloadHop(tag, ASSET, `${assetOrigin}${path}`);
    const script = bootstrapScript(`oversized-${name.replaceAll(" ", "-")}.sh`, (source) =>
      source.replace("MAX_ARCHIVE_BYTES=536870912", "MAX_ARCHIVE_BYTES=4096"));
    const marker = join(workspace, `refused-oversized-${name.replaceAll(" ", "-")}`);

    try {
      const result = await run(["sh", script], bootstrapEnv(marker));

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(reason);
      expect(existsSync(marker)).toBe(false);
    } finally {
      redirects.clear();
    }
  });
});

describe("the Windows bootstrap installer", () => {
  const powershell = process.platform === "win32"
    ? ["pwsh", "powershell"].find((shell) => Bun.which(shell) !== null)
    : undefined;

  /** Native Windows executes the installer; every other host reads the same
   * generated script contract without emulating Windows OS facilities. */
  function windowsEnv(marker: string, tag: string) {
    return { ...bootstrapEnv(marker), FLYWHEEL_VERSION: tag, PROCESSOR_ARCHITECTURE: "AMD64" };
  }

  test.skipIf(!powershell)("installs the tag it was given", async () => {
    publish("v6.5.0", tarball(windowsPayloadEntries("v6.5.0")));
    const marker = join(workspace, "windows-installed-tag");

    const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, "v6.5.0"));

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("v6.5.0");
  });

  test.skipIf(!powershell)("resolves latest once and installs the release that resolution selected", async () => {
    latestTag = "v6.5.1";
    publish("v6.5.1", tarball(windowsPayloadEntries("v6.5.1")));
    const marker = join(workspace, "windows-resolved-tag");

    const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, "latest"));

    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("v6.5.1");
  });

  test.skipIf(!powershell).each(admissionCorpus(WINDOWS_ROOT))("refuses a Windows archive holding %s, and installs nothing", async (name, extra, reason) => {
    publish("v6.6.0", tarball([...windowsPayloadEntries("v6.6.0"), extra]));
    const marker = join(workspace, `windows-refused-${name.replaceAll(" ", "-")}`);

    const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, "v6.6.0"));

    expect(result.exitCode).not.toBe(0);
    expect(statedMessage(result.stderr)).toContain(reason);
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(!powershell)("follows a chain of hops to the approved release-asset host", async () => {
    const tag = "v6.9.0";
    publish(tag, tarball(windowsPayloadEntries(tag)));
    statePayloadHop(tag, WINDOWS_ASSET, `${assetOrigin}/hop/1`);
    redirects.set("/hop/1", `${assetOrigin}/asset/${tag}/${WINDOWS_ASSET}`);
    requested.length = 0;
    const marker = join(workspace, "windows-hopped-tag");

    try {
      const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, tag));

      expect(result.exitCode).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe(tag);
      expect(requested).toContain("/hop/1");
      expect(requested).toContain(`/asset/${tag}/${WINDOWS_ASSET}`);
    } finally {
      redirects.clear();
    }
  });

  test.skipIf(!powershell).each(REFUSED_HOPS)("refuses a hop that names %s, and never requests it", async (name, location, reason) => {
    const tag = "v6.9.0";
    publish(tag, tarball(windowsPayloadEntries(tag)));
    statePayloadHop(tag, WINDOWS_ASSET, location(origin, server.port));
    requested.length = 0;
    const marker = join(workspace, `windows-refused-hop-${name.replaceAll(" ", "-")}`);

    try {
      const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, tag));

      expect(result.exitCode).not.toBe(0);
      expect(statedMessage(result.stderr)).toMatch(reason);
      expect(requested.filter((path) => path.includes("planted"))).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      redirects.clear();
    }
  });

  test.skipIf(!powershell)("refuses a chain of hops longer than it allows", async () => {
    const tag = "v6.9.0";
    publish(tag, tarball(windowsPayloadEntries(tag)));
    stateHopChain(tag, WINDOWS_ASSET);
    requested.length = 0;
    const marker = join(workspace, "windows-refused-hop-chain");

    try {
      const result = await run([powershell ?? "pwsh", "-NoProfile", "-File", installPs1], windowsEnv(marker, tag));

      expect(result.exitCode).not.toBe(0);
      expect(statedMessage(result.stderr)).toContain("redirected more than the 5 times allowed");
      expect(requested.filter((path) => path.startsWith("/hop/")).length).toBeLessThanOrEqual(5);
      expect(existsSync(marker)).toBe(false);
    } finally {
      redirects.clear();
    }
  });

  /** A body over the cap, and the refusal each way of hiding its size earns.
   *  The stated length is refused before one byte of the body is read; the
   *  chunked stream is refused on the bytes that arrive. */
  const oversized: readonly (readonly [string, string, RegExp])[] = [
    ["states a length over the cap", "/oversized/stated", /it states 262144 bytes, more than the 4096 allowed/],
    ["hides its length behind a chunked stream", "/oversized/hidden", /more than the 4096 bytes allowed/],
  ];

  test.skipIf(!powershell).each(oversized)("refuses a body that %s, and keeps no part of it", async (name, path, reason) => {
    const tag = "v6.9.1";
    publish(tag, tarball(windowsPayloadEntries(tag)));
    statePayloadHop(tag, WINDOWS_ASSET, `${assetOrigin}${path}`);
    // The staging directory is removed when the run ends, so this run keeps it:
    // what the refusal left behind is the whole point of the test.
    const script = windowsScript(`oversized-${name.replaceAll(" ", "-")}.ps1`, (source) =>
      source
        .replace("$MaxArchiveBytes = 536870912", () => "$MaxArchiveBytes = 4096")
        .replace("  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue", () => "  # kept for the test"));
    const scratch = mkdtempSync(join(workspace, "windows-scratch-"));
    const marker = join(workspace, `windows-refused-oversized-${name.replaceAll(" ", "-")}`);

    try {
      const result = await run(
        [powershell ?? "pwsh", "-NoProfile", "-File", script],
        { ...windowsEnv(marker, tag), TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      );

      expect(result.exitCode).not.toBe(0);
      expect(statedMessage(result.stderr)).toMatch(reason);
      expect(existsSync(marker)).toBe(false);
      const staging = readdirSync(scratch).filter((entry) => entry.startsWith("flywheel-install-"));
      expect(staging.length).toBe(1);
      expect(readdirSync(join(scratch, staging[0] ?? ""))).toEqual([]);
    } finally {
      redirects.clear();
    }
  });

  test.skipIf(!!powershell)("states the same admission contract as the Unix installer", () => {
    const source = readFileSync(INSTALL_PS1_SOURCE, "utf-8");
    expect(source).toContain("Resolve-LatestTag");
    expect(source).toContain("'^v\\d+\\.\\d+\\.\\d+$'");
    expect(source).toContain("$MaxEntries");
    expect(source).toContain("$MaxFileBytes");
    expect(source).toContain("$MaxArchiveBytes");
    expect(source).toContain("$MaxRedirects");
    expect(source).toContain("Assert-AllowedUrl");
    expect(source).toContain("$request.AllowAutoRedirect = $false");
    expect(source).toContain("ReadWriteTimeout");
    expect(source).toContain("holds a dot or an empty component");
    expect(source).toContain("two entries that name one path");
    expect(source).toContain("states more than the");
    expect(source).toContain("is not a regular file or a directory");
    expect(source).toContain("ReparsePoint");
    expect(source).toContain("checksum mismatch");
    expect(source).toContain("releases/download/$tag");
    expect(source).not.toContain("releases/latest/download");
  });
});
