/** Two claimants, one account, and the fence that orders them.
 *
 *  An atomic rename cannot order two valid update candidates: both are valid,
 *  and whichever lands last wins whether or not it is newer. The account
 *  authority is what orders them, and these tests drive the real SQLite
 *  authority and the real install engine against one account directory, so
 *  what they prove is what two processes would do.
 *
 *  Both crash windows are exercised as the states they leave behind, because
 *  that is all a later process can see: an attempt that died before the rename
 *  leaves no link, no launcher, and no committed check, and one that died after
 *  the rename leaves the link with the check still stale for the next claimant
 *  to repair. One of them is a real process that kills itself between the
 *  rename and the commit, which is the only way to observe that boundary
 *  without describing it. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAuthorityDbFile } from "../../../../src/infra/paths.js";
import { storedAuthorityState } from "../../../helpers/update-authority-state.js";
import { BUILD_METADATA_FILE, computeBuildId } from "../../../../src/infra/update/build-identity.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION, type UpdateAuthority } from "../../../../src/infra/update/update-authority.js";
import { installBuild, InstallRevokedError } from "../../../../src/orchestration/update/install-engine.js";
import { createUpdatePolicyStore } from "../../../../src/orchestration/update/update-policy.js";
import { placedBuildVersionAnswer } from "../../../helpers/placed-build.js";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";

const PLATFORM = "linux";
const PLATFORM_ARCH = "linux-x64";
const LEASE_MS = 60_000;
const START_MS = 1_000_000;

let home: string;
let userDataRoot: string;
let wrapperDir: string;
let payloads: string;
const opened: UpdateAuthority[] = [];
const serviceCommands: string[][] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-update-concurrency-"));
  userDataRoot = join(home, ".flywheel");
  wrapperDir = join(home, "bin");
  payloads = join(home, "payloads");
  mkdirSync(userDataRoot, { recursive: true });
  mkdirSync(payloads, { recursive: true });
  serviceCommands.length = 0;
});

afterEach(() => {
  while (opened.length > 0) opened.pop()?.dispose();
  rmSync(home, { recursive: true, force: true });
});

/** One complete payload tree. `name` lets a test hold two build identities at one version. */
async function payload(version: string, name = version, native = "native"): Promise<string> {
  const dir = join(payloads, name);
  mkdirSync(join(dir, "native", PLATFORM_ARCH), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  mkdirSync(join(dir, "webview"), { recursive: true });
  writeFileSync(join(dir, "flywheel-bin"), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(dir, "flywheel-bin"), 0o755);
  writeFileSync(join(dir, "native", PLATFORM_ARCH, "libsharp.so"), native);
  writeFileSync(join(dir, "fonts", "argon.otf"), "font");
  writeFileSync(join(dir, "webview", "index.html"), "<!doctype html>");
  const buildId = await computeBuildId(dir, process.platform);
  writeFileSync(join(dir, BUILD_METADATA_FILE), `${JSON.stringify({ version, buildId, asset: `flywheel-${PLATFORM_ARCH}.tar.gz` }, null, 2)}\n`);
  return dir;
}

function authorityState() {
  return storedAuthorityState(updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION));
}

function authority(): UpdateAuthority {
  const handle = createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
  opened.push(handle);
  return handle;
}

function win(handle: UpdateAuthority, nowMs: number): number {
  const claim = handle.claim({ nowMs, freshForMs: 0, leaseMs: LEASE_MS });
  if (claim.kind !== "won") throw new Error(`the claimant did not win the lease: ${claim.kind}`);
  return claim.fence;
}

function install(sourceDir: string, held: { readonly authority: UpdateAuthority; readonly fence: number }, nowMs: number): ReturnType<typeof installBuild> {
  return installBuild({
    userDataRoot,
    sourceDir,
    wrapperDir,
    platform: PLATFORM,
    platformArch: PLATFORM_ARCH,
    // The run proof precedes activation and is answered as a working build
    // answers it; every other command is a service command, recorded.
    runCommand: async (command) => {
      const version = placedBuildVersionAnswer(command);
      if (version === undefined) serviceCommands.push([...command]);
      const stdout = version ?? "";
      return { exitCode: 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: "", timedOut: false };
    },
    // The real policy authority, which is the only reader the engine consults.
    activation: { ...held, revalidate: createUpdatePolicyStore(userDataRoot).revalidate },
    nowMs: () => nowMs,
  });
}

function currentTarget(): string {
  return readlinkSync(join(userDataRoot, "current"));
}

/** These claimants install Unix builds, and a Unix build states its executable
 *  in a mode bit. Windows keeps none: a staged payload there cannot carry the
 *  bit the engine admits it by, so the coordination below is only observable on
 *  a filesystem that has one. A Windows build goes through the same engine and
 *  the same authority (ARCH-DISTRIBUTION-014, ARCH-DISTRIBUTION-020). */
const unixClaimants = describe.skipIf(!POSIX_FILE_MODES);

unixClaimants("two claimants of one account", () => {
  test("the same candidate twice places one build and activates it once more", async () => {
    const source = await payload("1.4.0");
    const first = authority();
    const placed = await install(source, { authority: first, fence: win(first, START_MS) }, START_MS);
    expect(placed.kind).toBe("placed");

    const second = authority();
    const again = await install(source, { authority: second, fence: win(second, START_MS + 1) }, START_MS + 1);

    expect(again.kind).toBe("present");
    expect(again.buildDir).toBe(placed.buildDir);
    expect(currentTarget()).toBe(placed.buildDir.slice(userDataRoot.length + 1));
    expect(readdirSync(join(userDataRoot, "versions"))).toEqual(["1.4.0"]);
  });

  test("a coordinated distinct build at the active version is placed but does not replace current", async () => {
    const firstSource = await payload("1.4.0", "first", "native-first");
    const secondSource = await payload("1.4.0", "second", "native-second");
    const first = authority();
    const active = await install(firstSource, { authority: first, fence: win(first, START_MS) }, START_MS);

    const second = authority();
    const placed = await install(secondSource, { authority: second, fence: win(second, START_MS + 1) }, START_MS + 1);

    expect(placed.kind).toBe("placed");
    expect(placed.buildDir).not.toBe(active.buildDir);
    expect(existsSync(placed.buildDir)).toBe(true);
    expect(currentTarget()).toBe(active.buildDir.slice(userDataRoot.length + 1));
    expect(readdirSync(join(userDataRoot, "versions", "1.4.0")).sort()).toEqual([active.buildId, placed.buildId].sort());
  });

  test("a claimant superseded while it worked publishes nothing, and the newer build stays active", async () => {
    const older = await payload("1.4.0");
    const newer = await payload("1.5.0");

    // The first claimant wins the lease and starts working.
    const stale = authority();
    const staleFence = win(stale, START_MS);

    // Its lease runs out while it downloads, so a second claimant takes the
    // account and installs the release it found.
    const fresh = authority();
    const afterExpiry = START_MS + LEASE_MS + 1;
    const winner = await install(newer, { authority: fresh, fence: win(fresh, afterExpiry) }, afterExpiry);
    expect(winner.version).toBe("1.5.0");
    const commandCount = serviceCommands.length;

    // The first claimant now finishes. Its fence is no longer the account's.
    expect(stale.renew({ fence: staleFence, nowMs: afterExpiry + 1, leaseMs: LEASE_MS })).toBe("superseded");
    await expect(install(older, { authority: stale, fence: staleFence }, afterExpiry + 1)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });

    expect(serviceCommands).toHaveLength(commandCount);
    expect(currentTarget()).toBe(winner.buildDir.slice(userDataRoot.length + 1));
    expect(currentTarget()).toContain("1.5.0");
  });

  test("a durable disable in another process revokes the held fence", async () => {
    const source = await payload("1.4.0");
    const writerUrl = new URL("../../../../src/orchestration/config/writer.ts", import.meta.url).href;
    const child = Bun.spawnSync(["bun", "-e", `const { updateAutoInstall } = await import(${JSON.stringify(writerUrl)}); const result = updateAutoInstall(false, { userDataRoot: process.env.TEST_USER_DATA_ROOT }); if (!result.ok) throw result.error;`], {
      env: { ...process.env, TEST_USER_DATA_ROOT: userDataRoot },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    if (!child.success) throw new Error(`disable process failed: ${child.stderr.toString()}`);
    const claimant = authority();
    const fence = win(claimant, START_MS);

    await expect(install(source, { authority: claimant, fence }, START_MS)).rejects.toThrow(InstallRevokedError);

    expect(serviceCommands).toHaveLength(0);
    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
    expect(authorityState().checkedAtMs).toBe(0);
  });

  test("a setting the loader repairs does not refuse the activation it already admitted", async () => {
    // The loader tolerates this value so a working setup is not bricked by it,
    // which is exactly why the engine must not re-decode the file itself: the
    // reader that admitted the install and the reader that activates it have
    // to be one reader.
    writeFileSync(join(userDataRoot, "flywheel.toml"), 'allow_persistent_processes = "yes"\n\n[updates]\nauto_install = true\n');
    const source = await payload("1.4.0");
    const claimant = authority();

    const placed = await install(source, { authority: claimant, fence: win(claimant, START_MS) }, START_MS);

    expect(placed.kind).toBe("placed");
    expect(currentTarget()).toBe(placed.buildDir.slice(userDataRoot.length + 1));
  });

  test("a config nobody can read revokes the activation instead of failing it", async () => {
    writeFileSync(join(userDataRoot, "flywheel.toml"), "this is not = = toml\n");
    const source = await payload("1.4.0");
    const claimant = authority();

    await expect(install(source, { authority: claimant, fence: win(claimant, START_MS) }, START_MS)).rejects.toThrow(InstallRevokedError);

    expect(serviceCommands).toHaveLength(0);
    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
  });
});

unixClaimants("what a crash leaves for the next claimant", () => {
  test("an attempt that dies before the rename leaves no link and no committed check", async () => {
    const source = await payload("1.4.0");
    // The launcher directory holds a file this installer may not replace, so
    // the installation refuses before anything is placed or activated.
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "flywheel"), "#!/bin/sh\n# someone else's launcher\n");

    const claimant = authority();
    const fence = win(claimant, START_MS);
    await expect(install(source, { authority: claimant, fence }, START_MS)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });

    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
    expect(authorityState()).toMatchObject({ checkedAtMs: 0, fence });

    // The next claimant, with the obstruction gone, installs cleanly.
    rmSync(join(wrapperDir, "flywheel"));
    const next = authority();
    const afterExpiry = START_MS + LEASE_MS + 1;
    const placed = await install(source, { authority: next, fence: win(next, afterExpiry) }, afterExpiry);

    expect(placed.kind).toBe("placed");
    expect(currentTarget()).toContain("1.4.0");
    expect(authorityState().checkedAtMs).toBe(afterExpiry);
  });

  test("an attempt that dies after the rename leaves the check stale, and the next claimant repairs only that", async () => {
    const source = await payload("1.4.0");
    const crashed = authority();
    const crashedFence = win(crashed, START_MS);
    const placed = await install(source, { authority: crashed, fence: crashedFence }, START_MS);
    const activeTarget = currentTarget();

    // Recreate the durable state a process death after rename but before commit
    // leaves. The production commit is one transaction, so only a direct fixture
    // mutation can represent that crash boundary after this successful install.
    crashed.dispose();
    const raw = new Database(updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION));
    raw.exec("update update_authority set checked_at = 0, lease_expires_at = 0 where id = 0");
    raw.close();
    expect(authorityState().checkedAtMs).toBe(0);

    const repairing = authority();
    const afterExpiry = START_MS + LEASE_MS + 1;
    expect(repairing.commitCheck({ fence: win(repairing, afterExpiry), checkedAtMs: afterExpiry })).toBe(true);

    expect(authorityState().checkedAtMs).toBe(afterExpiry);
    expect(currentTarget()).toBe(activeTarget);
    expect(readdirSync(join(userDataRoot, "versions", "1.4.0"))).toEqual([placed.buildId]);
  });
});

unixClaimants("what the activation order guarantees", () => {
  /** A handle that lets a test act in the one window between the `current`
   *  rename and everything the engine does after it. */
  function interruptedAfterRename(handle: UpdateAuthority, act: () => void): UpdateAuthority {
    return {
      ...handle,
      commitActivation: (request) => handle.commitActivation({
        ...request,
        activate: () => { request.activate(); act(); },
      }),
    };
  }

  test("a launcher taken over after the rename refuses, and the activation already made stands", async () => {
    const source = await payload("1.4.0");
    mkdirSync(wrapperDir, { recursive: true });
    const claimant = authority();
    const fence = win(claimant, START_MS);
    const intruded = interruptedAfterRename(claimant, () => {
      writeFileSync(join(wrapperDir, "flywheel"), "#!/bin/sh\n# someone else's launcher\n");
    });

    await expect(install(source, { authority: intruded, fence }, START_MS)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });

    expect(currentTarget()).toContain("1.4.0");
    expect(readFileSync(join(wrapperDir, "flywheel"), "utf8")).toContain("someone else");
  });

  test("a process killed after the rename leaves the build active, the launcher unwritten, and the check uncommitted", async () => {
    const source = await payload("1.4.0");
    const engineUrl = new URL("../../../../src/orchestration/update/install-engine.ts", import.meta.url).href;
    const authorityUrl = new URL("../../../../src/infra/update/update-authority.ts", import.meta.url).href;
    const pathsUrl = new URL("../../../../src/infra/paths.ts", import.meta.url).href;
    const placedBuildUrl = new URL("../../../helpers/placed-build.ts", import.meta.url).href;
    const script = `
      const { installBuild } = await import(${JSON.stringify(engineUrl)});
      const { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } = await import(${JSON.stringify(authorityUrl)});
      const { updateAuthorityDbFile } = await import(${JSON.stringify(pathsUrl)});
      const { placedBuildVersionAnswer } = await import(${JSON.stringify(placedBuildUrl)});
      const userDataRoot = process.env.TEST_USER_DATA_ROOT;
      const handle = createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
      const claim = handle.claim({ nowMs: ${START_MS}, freshForMs: 0, leaseMs: ${LEASE_MS} });
      const dying = { ...handle, commitActivation: (request) => handle.commitActivation({ ...request, activate: () => { request.activate(); process.kill(process.pid, "SIGKILL"); } }) };
      await installBuild({
        userDataRoot,
        sourceDir: process.env.TEST_SOURCE,
        wrapperDir: process.env.TEST_WRAPPER_DIR,
        platform: ${JSON.stringify(PLATFORM)},
        platformArch: ${JSON.stringify(PLATFORM_ARCH)},
        // The run proof is answered as a working build answers it; this
        // process launches nothing else, because it dies after the rename.
        runCommand: async (command) => {
          const stdout = placedBuildVersionAnswer(command);
          if (stdout === undefined) throw new Error("this process never launches another");
          return { exitCode: 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: "", timedOut: false };
        },
        activation: { authority: dying, fence: claim.fence, revalidate: async (decide) => decide({ effective: true }) },
        nowMs: () => ${START_MS},
      });
    `;

    const child = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, TEST_USER_DATA_ROOT: userDataRoot, TEST_SOURCE: source, TEST_WRAPPER_DIR: wrapperDir },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });

    expect(child.success).toBe(false);
    expect(currentTarget()).toContain("1.4.0");
    expect(existsSync(join(wrapperDir, "flywheel"))).toBe(false);
    expect(authorityState().checkedAtMs).toBe(0);

    // The next claimant finds the build already active and repairs only the check.
    const repairing = authority();
    const afterExpiry = START_MS + LEASE_MS + 1;
    expect(repairing.commitCheck({ fence: win(repairing, afterExpiry), checkedAtMs: afterExpiry })).toBe(true);
    expect(currentTarget()).toContain("1.4.0");
  });
});
