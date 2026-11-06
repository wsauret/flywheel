/** Cut and publish the next release, entirely from this machine.
 *
 *  GitHub Actions is retired from the release path to save minutes, so this
 *  script is the whole publication authority (ARCH-DISTRIBUTION-002): it gates the tree,
 *  builds every archive, composes the manifest and notes, and publishes to
 *  the public distribution repository through `gh`. The release the public
 *  repository serves as `latest` is the single authority for what "next"
 *  means, and it is read again at publish time so an older or equal release
 *  never becomes `latest`.
 *
 *  Order matters: the version is resolved and committed before the gates and
 *  builds run, so the archives that pass the gates are byte-identical to the
 *  archives that publish, and the tag names exactly the gated tree. The
 *  worktree must be clean including untracked files, because an untracked
 *  file can pass a local gate while being absent from the tag.
 *
 * Usage:
 *   bun run release                    # patch bump: 0.0.4 -> 0.0.5
 *   bun run release --minor            # 0.0.4 -> 0.1.0
 *   bun run release --major            # 0.0.4 -> 1.0.0
 *   bun run release --dry-run          # gates and builds; publishes nothing
 *   bun run release --rollback v0.0.1  # make an earlier release latest again
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { compareSemanticVersions, parseSemanticVersion } from "./release-version.js";
import { CHECKSUMMED_ASSETS, CLAUDE_MARKETPLACE_FILE, CLAUDE_PLUGIN_ARCHIVE, officialReleaseRefusal, RELEASE_ARCHIVES, RELEASE_ASSETS, RELEASE_BUILD_COMMANDS, RELEASE_TARGETS } from "./release-contract.js";
import { publishReleaseToMain } from "./release-main.js";
import { publishRelease, rollbackToRelease } from "./release-publish.js";
import { PUBLIC_REPO, latestReleaseTag } from "./release-repo.js";
import { hostBinaryPath } from "./binary-native-assets.js";
import { verifyPackagedTokenizer } from "./readiness-package-smoke.js";
import { engineBump } from "./claude-engine-release.js";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

function fail(reason: string): never {
  console.error(`release: ${reason}`);
  process.exit(1);
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) fail(`\`${command.join(" ")}\` failed:\n${result.stdout.toString().trim()}\n${result.stderr.toString().trim()}`.trim());
  return result.stdout.toString().trim();
}

function step(name: string, command: string[], env: typeof process.env = process.env): void {
  console.log(`release: ${name}`);
  const result = Bun.spawnSync(command, { cwd: ROOT, env, stdout: "inherit", stderr: "inherit", windowsHide: true });
  if (result.exitCode !== 0) fail(`${name} failed`);
}

async function verifyArchiveTokenizer(target: string, archive: string): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "flywheel-release-tokenizer-"));
  const stage = `flywheel-${target}`;
  const asset = posix.join(stage, "build", "native", target, "flywheel-tokenizer.wasm.zst");
  try {
    step(`extracting ${target} tokenizer`, ["tar", "-xzf", join(DIST, archive), "-C", temporary, asset]);
    await verifyPackagedTokenizer(join(temporary, ...asset.split("/")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Rollback is the one path that builds and gates nothing: it republishes an
// already-gated release. It shares this script so publication and rollback
// stay one authority.
const rollbackIndex = process.argv.indexOf("--rollback");
if (rollbackIndex !== -1) {
  const target = process.argv[rollbackIndex + 1];
  if (target === undefined) fail("state the release to roll back to: bun run release --rollback vMAJOR.MINOR.PATCH");
  const refused = rollbackToRelease(target);
  if (refused !== undefined) fail(refused);
  console.log(`release: ${PUBLIC_REPO} serves ${target} as latest again`);
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");

// The worktree must be clean, untracked files included: the tag names one
// commit, and everything the gates saw must be inside it.
const dirty = run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
if (dirty !== "") fail(`the worktree is not clean:\n${dirty}\nrelease from a fresh worktree of this repository, never a clone: git worktree add -b release ../flywheel-release origin/main`);

// An official release carries the maintainers' report endpoint, which only the
// official release machine's environment names. Refuse before anything is
// committed, so a forgotten variable never ships a release that reports nothing.
// A fork publishes to its own repository and builds without an endpoint.
const refusal = officialReleaseRefusal(process.env);
if (refusal !== undefined) fail(refusal);

// The hosted relay refuses a runtime on any relay protocol version but its
// own, so a binary is published only while the relay speaks the version the
// binary does. The relay deploys first (relay/README.md).
step("probing the hosted relay's protocol version (bun run --cwd relay probe:worker)", ["bun", "run", "--cwd", "relay", "probe:worker"]);

// A release never ships a Claude engine that newer releases superseded past the freshness window, unless a dated
// hold says why (scripts/claude-engine-release.ts). It runs before anything is committed.
step("checking the Claude engine pin (bun run check:claude-engine)", ["bun", "run", "check:claude-engine"]);

// Ship the freshest bundled models.dev snapshot the network can give us. The
// snapshot only serves when the live fetch and the disk archive are both
// unavailable, so the committed one is always valid; a refresh failure warns
// instead of blocking the release.
const refresh = Bun.spawnSync(["bun", "run", "scripts/refresh-models-snapshot.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true });
if (refresh.exitCode !== 0) {
  console.warn("release: bundled models.dev snapshot refresh failed; shipping the committed snapshot");
} else if (run(["git", "status", "--porcelain", "--", "src/infra/llm/models-bundled.txt"]) !== "") {
  run(["git", "add", "src/infra/llm/models-bundled.txt"]);
  run(["git", "commit", "-m", "chore: refresh bundled models.dev snapshot"]);
}

// Latest published release on the public repository, or none for the first.
// A read failure throws here rather than passing for an empty repository.
const latestTag = await latestReleaseTag();
const latest = latestTag === undefined ? undefined : parseSemanticVersion(latestTag);
if (latestTag !== undefined && latest === undefined) fail(`the latest release ${latestTag} is not a strict vMAJOR.MINOR.PATCH release`);

// The bump base is the highest version ever used, not just the published
// `latest`: after a rollback, `latest` points at an older release while the
// rolled-back version's tag still exists, and the next release must move
// past both (a downloaded version is never republished).
const localTags = run(["git", "tag", "--list", "v*"])
  .split("\n")
  .map((line) => parseSemanticVersion(line.trim().replace(/^v/, "")))
  .filter((candidate) => candidate !== undefined);
const base = [latest, ...localTags]
  .filter((candidate) => candidate !== undefined)
  .reduce((highest, candidate) => (compareSemanticVersions(candidate, highest) > 0 ? candidate : highest), { major: 0, minor: 0, patch: 0, canonical: "0.0.0" });

const bump = process.argv.includes("--major") ? "major" : process.argv.includes("--minor") ? "minor" : "patch";
const next =
  bump === "major" ? `${base.major + 1}.0.0`
  : bump === "minor" ? `${base.major}.${base.minor + 1}.0`
  : `${base.major}.${base.minor}.${base.patch + 1}`;
const tag = `v${next}`;

if (run(["git", "tag", "--list", tag]) !== "") fail(`the tag ${tag} already exists in this repository`);

// The version is committed before the gates and builds, so the gated tree,
// the tagged tree, and the built archives all state one version. A package
// that already states it (a prior aborted run) needs no commit.
const packageFile = Bun.file(join(ROOT, "package.json"));
const packageText = await packageFile.text();
const versionLine = /^(\s*"version":\s*)"[^"]*"/m;
if (!versionLine.test(packageText)) fail("package.json has no version line to update");
const bumped = packageText.replace(versionLine, `$1"${next}"`);
if (bumped !== packageText) await Bun.write(packageFile, bumped);

// The plugin's marketplace entry pins the digest of the exact zip this release
// uploads, and the host refuses a download that differs. The zip is built from
// the bundled prompt sources and the version alone, byte for byte the same on
// every build, so it is built here and its pin rides in the release commit:
// main never names a digest that the tagged tree does not produce.
step("building the Claude plugin and pinning it in the marketplace (bun run build:claude-plugin)", ["bun", "run", "build:claude-plugin", "--marketplace", PUBLIC_REPO]);
const pluginBytes = await Bun.file(join(DIST, CLAUDE_PLUGIN_ARCHIVE)).arrayBuffer();
if (run(["git", "status", "--porcelain=v1", "--untracked-files=all", "--", "package.json", CLAUDE_MARKETPLACE_FILE]) !== "") {
  run(["git", "add", "package.json", CLAUDE_MARKETPLACE_FILE]);
  run(["git", "commit", "-m", `release: ${tag}`]);
}

// Native legal attribution is generated where Cargo registry sources exist,
// before lint checks the frozen publication inputs without requiring Rust.
step("refreshing native dependency licenses", ["bun", "run", "scripts/cargo-license-ledger.ts", "crates/ripgrep"]);
step("refreshing the release license bundle", ["bun", "run", "licenses:generate"]);
const legalDirty = run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
if (legalDirty !== "") fail(`license generation changed the release tree:\n${legalDirty}`);

// The gates that used to run on the runners: lint, tests, boundaries, and
// the commit contract. The unit suite's duration budget only warns here: it
// protects development speed, and a slow run with no failure ships the same
// product (scripts/test-parallel.ts).
step("gating the tree (bun run test:ci)", ["bun", "run", "test:ci"], { ...process.env, TEST_BUDGET: "advisory" });

// A release that ships another Agent SDK than the last release ships a new Claude engine. It passes both
// qualification tiers here: the fake-host tier in the no-api suite and the live tier on this host's Claude login
// in the auth profile that FLYWHEEL_LIVE_AUTH_PROFILE names. The release-readiness passes on Linux and Windows owe
// the same.
const engine = engineBump(readFileSync(join(ROOT, "bun.lock"), "utf8"), latestTag === undefined ? undefined : { tag: latestTag, lockText: run(["git", "show", `${latestTag}:bun.lock`]) });
console.log(`release: ${engine.detail}`);
if (engine.bumped) step("qualifying the Claude engine bump (bun run test:integration:all)", ["bun", "run", "test:integration:all"]);

// Rebuild the universal tokenizer once. Every target build below copies these
// exact bytes, after the offline verifier proves their digest and ABI.
step("rebuilding tokenizer", ["bun", "run", "build:tokenizer"]);
const tokenizerDirty = run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
if (tokenizerDirty !== "") fail(`the tokenizer rebuild changed the release tree:\n${tokenizerDirty}`);
step("offline-verifying tokenizer", ["bun", "run", "build:tokenizer", "--verify"]);

// The canonical release plan explicitly compiles the repository-owned addon
// into every target archive instead of trusting a tracked prebuilt.
const archiveBytes = new Map<string, ArrayBuffer>();
for (const [index, command] of RELEASE_BUILD_COMMANDS.entries()) {
  const target = RELEASE_TARGETS[index]!;
  const archive = RELEASE_ARCHIVES[index]!;
  step(`building ${target}`, [...command]);
  const bytes = await Bun.file(join(DIST, archive)).arrayBuffer();
  archiveBytes.set(archive, bytes);
  await verifyArchiveTokenizer(target, archive);
}
step("verifying production composition", ["bun", "run", "scripts/verify-production-composition.ts", "--binary", hostBinaryPath(ROOT)]);

// The digest file, the manifest (which verifies every archive and the plugin
// against its stated digest), the installers, and the model-written notes.
archiveBytes.set(CLAUDE_PLUGIN_ARCHIVE, pluginBytes);
const digestLines = await Promise.all(
  CHECKSUMMED_ASSETS.map(async (name) => {
    const bytes = archiveBytes.get(name);
    if (bytes === undefined) fail(`${name} was not built in this release run`);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return `${hasher.digest("hex")}  ${name}`;
  }),
);
writeFileSync(join(DIST, "SHASUMS256.txt"), `${digestLines.join("\n")}\n`);
step("composing release.json", ["bun", "run", "scripts/build-release-manifest.ts", "--dist", "dist", "--repo", PUBLIC_REPO, "--version", next]);
copyFileSync(join(ROOT, "install.sh"), join(DIST, "install.sh"));
copyFileSync(join(ROOT, "install.ps1"), join(DIST, "install.ps1"));
// An installed client refuses only what a correct release can never fail, so
// every other restriction is this one: before anything is tagged, the staged
// release must keep the release contracts and be one that every served client
// accepts, by that client's own code (ARCH-DISTRIBUTION-009).
step("proving every served client accepts the release (scripts/release-acceptance.ts)", ["bun", "run", "scripts/release-acceptance.ts", "--dist", DIST, "--repo", PUBLIC_REPO]);
step("composing the terminal release notes (model rewrite)", ["bun", "run", "scripts/release-notes.ts", "--surface", "terminal", "--version", next, "--out", join(DIST, "release-notes.md")]);

// The full performance set runs on the exact host archive this release publishes.
step("gating release performance (bun run test:perf:release)", ["bun", "run", "test:perf:release", "--archive", join(DIST, `flywheel-${process.platform}-${process.arch}.tar.gz`)]);

// Every publishable asset must be staged before anything leaves this
// machine. The digests were verified when the manifest composed them;
// nothing has moved between machines since.
const missing = RELEASE_ASSETS.filter((name) => Bun.file(join(DIST, name)).size === 0);
if (missing.length > 0) fail(`staged assets are missing or empty: ${missing.join(", ")}`);

if (dryRun) {
  console.log(`release: dry run complete; ${tag} is gated and staged in dist/ and nothing was tagged or published`);
  process.exit(0);
}

const unsynced = publishReleaseToMain(tag, (args) => run(["git", ...args]));

const refused = await publishRelease(
  tag,
  RELEASE_ASSETS.map((name) => join(DIST, name)),
  join(DIST, "release-notes.md"),
);
if (refused !== undefined) fail(`${refused}\nthe draft was deleted; fix, delete the tag (git push origin :refs/tags/${tag} && git tag -d ${tag}), and release again`);

console.log(`${latestTag === undefined ? "first release" : `previous latest was ${latestTag}`}; published ${tag}`);
console.log(`lands: https://github.com/${PUBLIC_REPO}/releases/tag/${tag}`);
console.log(`then: review the published notes; iterate the prompt with bun run notes:draft`);
if (unsynced.length > 0) fail(`${tag} is published, but these checkouts of main lag origin; bring each one forward with git -C <checkout> merge --ff-only origin/main:\n${unsynced.join("\n")}`);