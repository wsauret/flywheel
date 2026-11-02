/** The transfer, end to end, against a real filesystem and a fake publisher.
 *
 *  Every test here answers one question about an untrusted download: what the
 *  account looks like afterwards. A refusal must leave `current` exactly as it
 *  was, leave no staging behind, and settle the launcher scope it opened,
 *  whether the publisher lied about the size, the digest, the entries, or the
 *  build. */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { failContainedFileRemoval, recordContainedWrites } from "../../../helpers/contained-writes.js";
import { paxRecords, tarBlocks } from "../../../helpers/tar-archive.js";
import { account, ASSET_URL, bodyOf, buildArchive, filesUnder, harness, pieces, PLATFORM_ARCH, POSIX_HOST, redirectTo, rejection, releaseOf, stallingBody, VERSION, versionsEntries, useFreshAccount, type PayloadFile } from "./_update-install-harness.js";

/** One payload file large enough that a whole-archive reader would be obvious,
 *  and small enough for a unit test to build, hash, and extract. Its bytes are
 *  random, because a build payload is a binary that barely compresses. */
const LARGE_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** The decompressed size of the hostile entry: large on disk, a few dozen
 *  KiB compressed. */
const HOSTILE_ENTRY_BYTES = 64 * 1024 * 1024;

useFreshAccount();

describe.skipIf(!POSIX_HOST)("a verified release archive", () => {
  test("is extracted, proved, and activated under the fence the caller holds", async () => {
    const archive = await buildArchive();
    const run = harness(() => bodyOf([archive]));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });

    expect(readFileSync(join(account.userDataRoot, "current", "flywheel-bin"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(readFileSync(join(account.wrapperDir, "flywheel"), "utf8")).toContain("flywheel-owned-wrapper");
    // The installer may run on another thread than the claimant, so it
    // commits under the handed fence through a handle of its own and closes it.
    expect(run.authority.activations).toBe(1);
    expect(run.authority.disposals).toBe(1);
    // The build tree is the only thing left under versions: staging is gone.
    expect(versionsEntries()).toEqual([VERSION]);
  });

  test("creates the wrapper directory chain a fresh account does not have yet", async () => {
    // The default wrapper directory is ~/.local/bin: on a first install
    // neither ~/.local nor ~/.local/bin exists.
    account.wrapperDir = join(account.home, ".local", "bin");
    const archive = await buildArchive();
    const run = harness(() => bodyOf([archive]));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(readFileSync(join(account.wrapperDir, "flywheel"), "utf8")).toContain("flywheel-owned-wrapper");
  });

  test("opens one launcher scope for the attempt and settles it before it answers", async () => {
    const archive = await buildArchive();
    const run = harness(() => bodyOf([archive]));

    await run.install(releaseOf(archive));

    expect(run.launcher.opened).toBe(1);
    expect(run.launcher.closed).toBe(1);
    // The run proof asks the staged executable its version before the build
    // takes its name, then the service is ensured through the wrapper. An
    // update states itself, so the service boundary creates no registration
    // that a person's Process initiation Off removed.
    expect(run.launcher.spawned).toBe(2);
    expect(run.launcher.launches).toEqual([
      [expect.stringMatching(new RegExp(`/versions/${VERSION.replaceAll(".", "\\.")}/\\.staging\\.[0-9]+\\.[0-9a-f]+/flywheel-bin$`)), "--version"],
      [join(account.wrapperDir, "flywheel"), "serve", "install", "--update"],
    ]);
  });

  test("follows a redirect to a release-asset host", async () => {
    const archive = await buildArchive();
    const run = harness((url) => (url === ASSET_URL ? redirectTo("https://objects.githubusercontent.com/blob") : bodyOf([archive])));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toEqual([ASSET_URL, "https://objects.githubusercontent.com/blob"]);
  });

  test("follows a redirect to a host no earlier client allowed, because the digest proves the bytes", async () => {
    const archive = await buildArchive();
    const run = harness((url) => (url === ASSET_URL ? redirectTo("https://mirror.example.net/blob?token=1") : bodyOf([archive])));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toEqual([ASSET_URL, "https://mirror.example.net/blob?token=1"]);
  });

  test("refuses a redirect to plain HTTP, and installs nothing", async () => {
    const archive = await buildArchive();
    const run = harness(() => redirectTo("http://mirror.example.net/blob"));

    await expect(run.install(releaseOf(archive))).rejects.toThrow("does not use HTTPS");
    expect(existsSync(join(account.userDataRoot, "current"))).toBe(false);
    expect(versionsEntries()).toEqual([]);
  });

  test("installs an archive past the listing bounds an earlier client set", async () => {
    // v0.1.0 refused an extended header over 8 KiB, a build.json over 8 KiB,
    // a GNU long name, and any build not at flywheel-<target>/build. None of
    // them is this client's business. The entry count is not either, and
    // archive-entry.test.ts lists 20,000 entries.
    const longName = `${"deep/".repeat(40)}file.txt`;
    const archive = await buildArchive({
      root: "release/2.0",
      metadata: { notes: "x".repeat(16 * 1024), asset: "flywheel-linux-x64-musl.tar.zst" },
      extra: [
        { name: "././@LongLink", typeflag: "L", mode: 0o644, content: `release/2.0/build/${longName}\0` },
        { name: "placeholder", typeflag: "0", mode: 0o644, content: "long" },
        { name: "PaxHeaders/padded", typeflag: "x", mode: 0o644, content: paxRecords({ comment: "y".repeat(9 * 1024), path: "release/2.0/build/pax-named.txt" }) },
        { name: "short", typeflag: "0", mode: 0o644, content: "pax" },
      ],
    });
    const run = harness(() => bodyOf([archive]));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(readFileSync(join(account.userDataRoot, "current", ...longName.split("/")), "utf8")).toBe("long");
    expect(readFileSync(join(account.userDataRoot, "current", "pax-named.txt"), "utf8")).toBe("pax");
  });
});

describe.skipIf(!POSIX_HOST)("a staged build that does not prove it runs here", () => {
  test("is neither placed nor activated when its executable exits non-zero", async () => {
    const archive = await buildArchive();
    const run = harness(() => bodyOf([archive]), (command) => (command[1] === "--version" ? { code: 134, stderr: "dyld: Library not loaded\n" } : { code: 0 }));

    await expect(run.install(releaseOf(archive))).rejects.toThrow("exited 134 when it was asked its version: dyld: Library not loaded");

    expect(existsSync(join(account.userDataRoot, "current"))).toBe(false);
    expect(existsSync(join(account.wrapperDir, "flywheel"))).toBe(false);
    expect(run.authority.activations).toBe(0);
    // A build that never ran here takes no name, so it never fills the
    // collector's retention band, and its staging is gone.
    expect(readdirSync(join(account.userDataRoot, "versions", VERSION))).toEqual([]);
  });

  test("is placed and activated when it answers in words an earlier client did not expect", async () => {
    // A later release may print its version another way; it starts, so it runs here.
    const archive = await buildArchive();
    const run = harness(() => bodyOf([archive]), (command) => (command[1] === "--version" ? { code: 0, stdout: "Flywheel v2 - build unknown\n" } : { code: 0 }));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.authority.activations).toBe(1);
  });
});

describe.skipIf(!POSIX_HOST)("a publisher whose answer is not the release it described", () => {
  test("refuses a body whose digest is not the stated one", async () => {
    const archive = await buildArchive();
    const release = releaseOf(archive);
    const run = harness(() => bodyOf([archive]));

    await expect(run.install({ ...release, asset: { ...release.asset, sha256: "b".repeat(64) } })).rejects.toThrow("digests to");
    expect(existsSync(join(account.userDataRoot, "current"))).toBe(false);
    expect(versionsEntries()).toEqual([]);
    expect(run.launcher.opened).toBe(0);
  });

  test("refuses a body larger than the stated size", async () => {
    const archive = await buildArchive();
    const release = releaseOf(archive);
    const run = harness(() => bodyOf([archive]));

    await expect(run.install({ ...release, asset: { ...release.asset, sizeBytes: archive.byteLength - 16 } })).rejects.toThrow(`delivers more than the ${archive.byteLength - 16} bytes the release states`);
    expect(versionsEntries()).toEqual([]);
  });

  test("refuses an HTTP rejection without asking again", async () => {
    const archive = await buildArchive();
    const run = harness(() => (rejection(404)));

    await expect(run.install(releaseOf(archive))).rejects.toThrow("answered 404");
    expect(run.requests).toHaveLength(1);
  });
});

describe.skipIf(!POSIX_HOST)("an archive entry this client cannot place on every platform", () => {
  test("a symbolic link is left out, so nothing it names is reached, and the rest is installed", async () => {
    const archive = await buildArchive({ extra: [{ name: `flywheel-${PLATFORM_ARCH}/build/escape`, typeflag: "2", mode: 0o777, linkname: "/etc/passwd" }] });
    const run = harness(() => bodyOf([archive]));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(existsSync(join(account.userDataRoot, "current", "escape"))).toBe(false);
  });

  test("a hard link is placed as the file it names", async () => {
    const root = `flywheel-${PLATFORM_ARCH}/build`;
    const archive = await buildArchive({ extra: [{ name: `${root}/flywheel-copy`, typeflag: "1", mode: 0o755, linkname: `${root}/flywheel-bin` }] });
    const run = harness(() => bodyOf([archive]));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(readFileSync(join(account.userDataRoot, "current", "flywheel-copy"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  test("an archive with no build.json holds no build and is refused", async () => {
    const archive = gzipSync(tarBlocks([{ name: "root/readme", typeflag: "0", mode: 0o644, content: "nothing" }]));
    const run = harness(() => bodyOf([archive]));

    await expect(run.install(releaseOf(archive))).rejects.toThrow("holds no build.json");
    expect(versionsEntries()).toEqual([]);
  });
});

describe.skipIf(!POSIX_HOST)("an archive that is proved before it is read", () => {
  test("writes nothing but the compressed download until its digest is proved, so a hostile archive is refused unread", async () => {
    // A host on the redirect chain serves the wrong archive: an extended
    // header that states a large allocation, and an entry of zeros that
    // decompresses to far more than its compressed size.
    const hostile = gzipSync(tarBlocks([
      { name: "PaxHeaders/bomb", typeflag: "x", mode: 0o644, content: new Uint8Array(HOSTILE_ENTRY_BYTES / 4) },
      { name: `flywheel-${PLATFORM_ARCH}/build/zeros.bin`, typeflag: "0", mode: 0o644, content: new Uint8Array(HOSTILE_ENTRY_BYTES) },
    ]));
    const genuine = releaseOf(await buildArchive());
    const writes = recordContainedWrites();
    const run = harness(() => bodyOf(pieces(hostile, 8)));

    await expect(run.install({ ...genuine, asset: { ...genuine.asset, sizeBytes: hostile.byteLength } })).rejects.toThrow("digests to");
    // One file, holding exactly the compressed bytes the host sent.
    expect(writes).toEqual([{ name: "download", bytes: hostile.byteLength }]);
    expect(filesUnder(account.userDataRoot)).toEqual([]);
    expect(run.launcher.opened).toBe(0);
  });

  test("a large proved archive is extracted whole", async () => {
    const large: PayloadFile = { path: "large.bin", mode: 0o644, content: randomBytes(LARGE_PAYLOAD_BYTES) };
    const archive = await buildArchive({ payload: [large] });
    const run = harness(() => bodyOf(pieces(archive, 8)));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(statSync(join(account.userDataRoot, "current", "large.bin")).size).toBe(LARGE_PAYLOAD_BYTES);
  });

  test("a withdrawal while the archive streams leaves nothing spooled", async () => {
    const archive = await buildArchive();
    const withdrawal = new AbortController();
    const run = harness((_url, signal) => stallingBody(signal, [archive.subarray(0, 64)]));

    const settled = run.install(releaseOf(archive), withdrawal.signal);
    await Bun.sleep(1);
    withdrawal.abort();

    expect(await settled).toEqual({ kind: "revoked" });
    expect(filesUnder(account.userDataRoot)).toEqual([]);
  });

  test("states what the reader refused, not only the bytes the publisher still owed", async () => {
    // The refused entry is followed by enough incompressible tail that the
    // reader answers while the transfer is still short, which is the ordinary
    // case for a multi-megabyte asset and the one a single-chunk body hides.
    const archive = await buildArchive({
      extra: [
        { name: "../escaped.txt", typeflag: "0", mode: 0o644, content: "planted" },
        { name: `flywheel-${PLATFORM_ARCH}/build/tail.bin`, typeflag: "0", mode: 0o644, content: randomBytes(LARGE_PAYLOAD_BYTES) },
      ],
    });
    const run = harness(() => bodyOf(pieces(archive, 256)));

    await expect(run.install(releaseOf(archive))).rejects.toThrow("..");
    expect(filesUnder(account.userDataRoot)).toEqual([]);
  });

  test("a proved download that will not unlink neither fails the install nor hides a refusal", async () => {
    failContainedFileRemoval("download", "EBUSY: resource busy or locked, unlink 'download'");
    const archive = await buildArchive();
    const refused = gzipSync(tarBlocks([{ name: "root/readme", typeflag: "0", mode: 0o644, content: "nothing" }]));

    expect(await harness(() => bodyOf([archive])).install(releaseOf(archive))).toEqual({ kind: "installed" });
    await expect(harness(() => bodyOf([refused])).install(releaseOf(refused))).rejects.toThrow("holds no build.json");
  });
});
