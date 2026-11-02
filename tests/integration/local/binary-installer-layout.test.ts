/** What one Unix installation must be true of, proved against real
 *  directories: an immutable build tree, one link every launch resolves, a
 *  wrapper that reaches the build through that link, and a cleanup that
 *  removes only what Flywheel wrote.
 *
 *  The payload here is a small shell executable rather than a compiled
 *  binary. Everything the engine promises is about identity, placement,
 *  activation, and ownership, and none of that depends on what the executable
 *  is. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBuildId } from "../../../src/infra/update/build-identity.js";
import { installBuild } from "../../../src/orchestration/update/install-engine.js";
import { placedBuildVersionAnswer } from "../../helpers/placed-build.js";

/** This installation is Unix's: one `current` symlink activation atomically
 *  replaces, and a shell wrapper that reaches the build through that link.
 *  The same engine installs a Windows build with a pointer file and the
 *  Windows launcher, which `tests/unit/orchestration/update/windows-install.test.ts`
 *  proves. */
const unixInstallation = describe.skipIf(process.platform === "win32");

const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const ASSET = `flywheel-${PLATFORM_ARCH}.tar.gz`;

let home: string;
let userDataRoot: string;
let wrapperDir: string;
let payloads: string;
const commands: string[][] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-install-home-"));
  userDataRoot = join(home, ".flywheel");
  wrapperDir = join(home, "bin");
  payloads = mkdtempSync(join(tmpdir(), "flywheel-install-payload-"));
  commands.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(payloads, { recursive: true, force: true });
});

/** Every process launch the engine makes, recorded instead of run. A placed
 *  build answers its version the way a working build does. */
const runCommand = async (command: readonly string[]): Promise<{ exitCode: number; stdoutBytes: Uint8Array; stdout: string; stderr: string; timedOut: boolean }> => {
  commands.push([...command]);
  const stdout = placedBuildVersionAnswer(command) ?? "";
  return { exitCode: 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: "", timedOut: false };
};

async function makePayload(name: string, options: { readonly version: string; readonly mark?: string }): Promise<{ readonly dir: string; readonly buildId: string }> {
  const dir = join(payloads, name);
  mkdirSync(join(dir, "native", PLATFORM_ARCH), { recursive: true });
  mkdirSync(join(dir, "fonts"), { recursive: true });
  mkdirSync(join(dir, "webview"), { recursive: true });
  writeFileSync(join(dir, "flywheel-bin"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "flywheel ${options.version}"; fi\necho "native:$FLYWHEEL_NATIVE_DIR"\n`);
  chmodSync(join(dir, "flywheel-bin"), 0o755);
  writeFileSync(join(dir, "native", PLATFORM_ARCH, "libopentui.txt"), options.mark ?? "native");
  writeFileSync(join(dir, "fonts", "monaspace.txt"), "font");
  writeFileSync(join(dir, "webview", "index.html"), "<!doctype html>");
  const buildId = await computeBuildId(dir, process.platform);
  writeFileSync(join(dir, "build.json"), `${JSON.stringify({ version: options.version, buildId, asset: ASSET }, null, 2)}\n`);
  return { dir, buildId };
}

function install(sourceDir: string, into: string = wrapperDir): ReturnType<typeof installBuild> {
  return installBuild({ userDataRoot, sourceDir, wrapperDir: into, platform: process.platform, platformArch: PLATFORM_ARCH, runCommand });
}

function launchWrapper(wrapperPath: string) {
  const result = Bun.spawnSync(["bash", wrapperPath, "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runWrapper(wrapperPath: string): string {
  const result = launchWrapper(wrapperPath);
  if (result.exitCode !== 0) throw new Error(`the wrapper failed: ${result.stderr}`);
  return result.stdout;
}

async function writeProductionWrapperFixture(): Promise<string> {
  const outcome = await install((await makePayload(`wrapper-${crypto.randomUUID()}`, { version: "0.0.1" })).dir)
  const text = readFileSync(outcome.wrapperPath, "utf-8")
  rmSync(userDataRoot, { recursive: true, force: true })
  return text
}

unixInstallation("installing one build", () => {
  test("the packaged shell installer prints start instructions only after a successful install", async () => {
    const generator = readFileSync(new URL("../../../scripts/build-binary.ts", import.meta.url), "utf-8");
    const declaration = generator.indexOf("function unixInstallScript(");
    const opened = generator.indexOf("`", declaration);
    const closed = generator.indexOf("`;", opened);
    const shell = generator.slice(opened + 1, closed)
      .replaceAll("\\\\", "\\").replaceAll("\\$", "$")
      .replaceAll(/\$\{targetBinaryName\}/g, "flywheel-bin").replaceAll(/\$\{packageVersion\}/g, "1.2.3");
    const installer = join(payloads, "install.sh");
    writeFileSync(installer, shell);
    mkdirSync(join(payloads, "build"));
    const executable = join(payloads, "build", "flywheel-bin");
    mkdirSync(join(home, ".flywheel", "current"), { recursive: true });
    writeFileSync(join(home, ".flywheel", "current", "build.json"), '{"version":"0.9.0"}');
    mkdirSync(wrapperDir);
    writeFileSync(join(wrapperDir, "flywheel"), "#!/bin/sh\necho UNOWNED-COMMAND-RAN\n", { mode: 0o755 });
    for (const exit of [7, 0]) {
      writeFileSync(executable, `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 });
      const child = Bun.spawn(["sh", installer], {
        env: { ...process.env, HOME: home, FLYWHEEL_INSTALL_DIR: wrapperDir, FLYWHEEL_NO_MODIFY_PATH: "1" },
        stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode).toBe(exit);
      expect(stderr).toBe("");
      expect(stdout).toContain("Installing flywheel version: 1.2.3");
      expect(stdout).toContain("Installed version: 0.9.0");
      expect(stdout).not.toContain("UNOWNED-COMMAND-RAN");
      expect(stdout).not.toContain("\x1b");
      if (exit === 0) {
        expect(stdout).toContain("Flywheel installed");
        expect(stdout).toContain("cd <project>");
        expect(stdout).toContain("flywheel      # Start Flywheel");
      } else {
        expect(stdout).not.toContain("Flywheel installed");
        expect(stdout).not.toContain("To start:");
      }
    }
  });

  test("the install role reports a payload error without leaking cleanup diagnostics", async () => {
    const entry = new URL("../../../src/cli/binary-install.ts", import.meta.url).href;
    const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", `import { runBinaryInstall } from ${JSON.stringify(entry)}; process.exitCode = await runBinaryInstall()`], {
      cwd: home,
      env: { ...process.env, HOME: home, FLYWHEEL_INSTALL_DIR: wrapperDir },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("flywheel install:");
    expect(stderr).not.toContain('"type":"log.');
    expect(stderr).not.toContain("launcher scope closing");
  });

  test("places an immutable build tree, links it, and runs it through the wrapper", async () => {
    const payload = await makePayload("first", { version: "1.2.3" });

    const outcome = await install(payload.dir);

    expect(outcome.kind).toBe("placed");
    expect(outcome.buildDir).toBe(join(userDataRoot, "versions", "1.2.3", payload.buildId));
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(outcome.buildDir));
    expect(lstatSync(join(userDataRoot, "current")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(outcome.buildDir, "build.json"), "utf-8"))).toMatchObject({ version: "1.2.3", buildId: payload.buildId, asset: ASSET });
    expect(readFileSync(join(outcome.buildDir, "webview", "index.html"), "utf-8")).toBe("<!doctype html>");

    const older = await makePayload("older", { version: "1.1.0" });
    await expect(install(older.dir)).rejects.toThrow("activation must move forward");
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(outcome.buildDir));

    const output = runWrapper(outcome.wrapperPath);
    expect(output).toContain("flywheel 1.2.3");
    expect(output).toContain(`native:${realpathSync(outcome.buildDir)}/native/${PLATFORM_ARCH}`);
  });

  test("clears the macOS quarantine attribute through a fixed argv, and re-signs nothing", async () => {
    const payload = await makePayload("first", { version: "1.2.3" });

    await install(payload.dir);

    if (process.platform === "darwin") {
      expect(commands[0]?.slice(0, 3)).toEqual(["/usr/bin/xattr", "-dr", "com.apple.quarantine"]);
    }
    expect(commands.at(-1)).toEqual([join(wrapperDir, "flywheel"), "serve", "install"]);
    expect(commands.flat()).not.toContain("codesign");
  });

  test("reinstalling the same build changes nothing", async () => {
    const payload = await makePayload("first", { version: "1.2.3" });
    const first = await install(payload.dir);
    const placed = statSync(first.buildDir);

    const again = await install(payload.dir);

    expect(again.kind).toBe("present");
    expect(again.buildDir).toBe(first.buildDir);
    expect(statSync(again.buildDir).ino).toBe(placed.ino);
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(first.buildDir));
    expect(commands.filter((command) => command.at(-2) === "serve" && command.at(-1) === "install")).toEqual([
      [join(wrapperDir, "flywheel"), "serve", "install"],
      [join(wrapperDir, "flywheel"), "serve", "install"],
    ]);
  });

  test("answers what the account service command printed for the person, such as the Linux logout notice", async () => {
    const payload = await makePayload("service-notice", { version: "1.2.3" });
    const notice = "Flywheel stops when you log out, because lingering is off for wes. To keep Flywheel running after you log out, run `sudo loginctl enable-linger wes` on this machine.";
    const noticing = async (command: readonly string[]) => {
      commands.push([...command]);
      const stdout = command.at(-2) === "serve" && command.at(-1) === "install" ? `${notice}\n` : placedBuildVersionAnswer(command) ?? "";
      return { exitCode: 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: "", timedOut: false };
    };

    const installed = await installBuild({ userDataRoot, sourceDir: payload.dir, wrapperDir, platform: process.platform, platformArch: PLATFORM_ARCH, runCommand: noticing });

    expect(installed.serviceOutput).toBe(notice);
  });

  test("reports service setup failure after activation and wrapper publication", async () => {
    const payload = await makePayload("service-failure", { version: "1.2.3" });
    const failingCommand = async (command: readonly string[]) => {
      commands.push([...command]);
      const serviceEnsure = command.at(-2) === "serve" && command.at(-1) === "install";
      const stdout = placedBuildVersionAnswer(command) ?? "";
      return { exitCode: serviceEnsure ? 17 : 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: serviceEnsure ? "service manager unavailable" : "", timedOut: false };
    };

    await expect(installBuild({
      userDataRoot,
      sourceDir: payload.dir,
      wrapperDir,
      platform: process.platform,
      platformArch: PLATFORM_ARCH,
      runCommand: failingCommand,
    })).rejects.toThrow("service manager unavailable");

    expect(realpathSync(join(userDataRoot, "current"))).toContain(payload.buildId);
    expect(existsSync(join(wrapperDir, "flywheel"))).toBe(true);
  });

  test("a second explicit build of one version becomes current and leaves the first untouched", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    const firstNative = readFileSync(join(first.buildDir, "native", PLATFORM_ARCH, "libopentui.txt"), "utf-8");

    const second = await install((await makePayload("second", { version: "1.2.3", mark: "rebuilt" })).dir);

    expect(second.kind).toBe("placed");
    expect(second.buildDir).not.toBe(first.buildDir);
    expect(existsSync(first.buildDir)).toBe(true);
    expect(readFileSync(join(first.buildDir, "native", PLATFORM_ARCH, "libopentui.txt"), "utf-8")).toBe(firstNative);
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(second.buildDir));
    expect(readFileSync(join(second.buildDir, "native", PLATFORM_ARCH, "libopentui.txt"), "utf-8")).toBe("rebuilt");
  });

  test("refuses a payload whose tree differs from the installed build its metadata names, and keeps that build", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    const tampered = await makePayload("tampered", { version: "1.2.3" });
    writeFileSync(join(tampered.dir, "build.json"), readFileSync(join(first.buildDir, "build.json")));
    writeFileSync(join(tampered.dir, "fonts", "monaspace.txt"), "tampered");

    await expect(install(tampered.dir)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(first.buildDir));
    expect(readFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "utf-8")).not.toBe("tampered");
  });

  test("installs a payload that carries no webview, because which directories a build holds is the release's", async () => {
    const payload = await makePayload("missing-webview", { version: "1.2.3" });
    rmSync(join(payload.dir, "webview"), { recursive: true });
    const buildId = await computeBuildId(payload.dir, process.platform);
    writeFileSync(join(payload.dir, "build.json"), `${JSON.stringify({ version: "1.2.3", buildId }, null, 2)}\n`);

    expect((await install(payload.dir)).kind).toBe("placed");
  });
});

unixInstallation("the wrapper directory", () => {
  const legacyWrapper = `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SELF_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
export FLYWHEEL_NATIVE_DIR="$SELF_DIR/native/${PLATFORM_ARCH}"
exec "$SELF_DIR/flywheel-bin" "$@"
`;

  function writeLegacyLayout(dir: string = wrapperDir): void {
    mkdirSync(join(dir, "native", PLATFORM_ARCH), { recursive: true });
    mkdirSync(join(dir, "fonts"), { recursive: true });
    writeFileSync(join(dir, "flywheel"), legacyWrapper);
    chmodSync(join(dir, "flywheel"), 0o755);
    writeFileSync(join(dir, "flywheel-bin"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(dir, "native", PLATFORM_ARCH, "libopentui.txt"), "old");
    writeFileSync(join(dir, "fonts", "monaspace.txt"), "old");
  }

  test("migrates exactly the flat layout the previous installer wrote", async () => {
    writeLegacyLayout();
    const payload = await makePayload("first", { version: "1.2.3" });

    const outcome = await install(payload.dir);

    expect(readFileSync(outcome.wrapperPath, "utf-8")).toContain(userDataRoot);
    expect(existsSync(join(wrapperDir, "flywheel-bin"))).toBe(false);
    expect(existsSync(join(wrapperDir, "native"))).toBe(false);
    expect(existsSync(join(wrapperDir, "fonts"))).toBe(false);
    expect(runWrapper(outcome.wrapperPath)).toContain("flywheel 1.2.3");
  });

  test("replaces a wrapper this installer wrote and keeps its mode", async () => {
    mkdirSync(wrapperDir, { recursive: true });
    const prior = await writeProductionWrapperFixture();
    writeFileSync(join(wrapperDir, "flywheel"), prior.replaceAll(userDataRoot, "/somewhere/else"));
    chmodSync(join(wrapperDir, "flywheel"), 0o755);

    const outcome = await install((await makePayload("first", { version: "1.2.3" })).dir);

    expect(readFileSync(outcome.wrapperPath, "utf-8")).toContain(userDataRoot);
    expect(lstatSync(outcome.wrapperPath).mode & 0o777).toBe(0o755);
  });

  test("writes a POSIX sh launcher, so a system with no bash runs it", async () => {
    const outcome = await install((await makePayload("first", { version: "1.2.3" })).dir);
    const text = readFileSync(outcome.wrapperPath, "utf-8");

    expect(text.startsWith("#!/bin/sh\n# flywheel-owned-wrapper v1\n")).toBe(true);
    const result = Bun.spawnSync(["sh", outcome.wrapperPath, "--version"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("flywheel 1.2.3");
  });

  test("replaces the bash launcher a previous release wrote", async () => {
    // The shape every release before the POSIX launcher wrote: the same body
    // under a bash header. It stays Flywheel's to replace until 2027-03-23.
    mkdirSync(wrapperDir, { recursive: true });
    const prior = (await writeProductionWrapperFixture()).replace("#!/bin/sh\n", "#!/usr/bin/env bash\n").replace("set -eu\n", "set -euo pipefail\n");
    expect(prior.startsWith("#!/usr/bin/env bash\n# flywheel-owned-wrapper v1\n")).toBe(true);
    writeFileSync(join(wrapperDir, "flywheel"), prior.replaceAll(userDataRoot, "/somewhere/else"));
    chmodSync(join(wrapperDir, "flywheel"), 0o755);

    const outcome = await install((await makePayload("first", { version: "1.2.3" })).dir);

    expect(readFileSync(outcome.wrapperPath, "utf-8").startsWith("#!/bin/sh\n")).toBe(true);
    expect(readFileSync(outcome.wrapperPath, "utf-8")).toContain(userDataRoot);
  });

  const intruders: readonly (readonly [string, (dir: string) => void])[] = [
    ["an unrelated file at flywheel", (dir) => { writeFileSync(join(dir, "flywheel"), "#!/bin/sh\necho someone else\n"); }],
    ["a directory at flywheel", (dir) => { mkdirSync(join(dir, "flywheel")); }],
    ["a symlink at flywheel", (dir) => { symlinkSync("/bin/sh", join(dir, "flywheel")); }],
    ["an unrelated file at flywheel-bin", (dir) => { writeFileSync(join(dir, "flywheel-bin"), "someone else\n"); }],
    ["an unrelated directory at native", (dir) => { mkdirSync(join(dir, "native")); }],
    ["an unrelated directory at fonts", (dir) => { mkdirSync(join(dir, "fonts")); }],
  ];

  test.each(intruders)("refuses %s, and installs nothing", async (_name, plant) => {
    mkdirSync(wrapperDir, { recursive: true });
    plant(wrapperDir);
    const payload = await makePayload("first", { version: "1.2.3" });

    await expect(install(payload.dir)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });
    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
    expect(existsSync(join(userDataRoot, "versions", "1.2.3", payload.buildId))).toBe(false);
  });

  test("refuses a wrapper that is also reachable under another name", async () => {
    await writeProductionWrapperFixture();
    linkSync(join(wrapperDir, "flywheel"), join(wrapperDir, "flywheel-also"));

    await expect(install((await makePayload("first", { version: "1.2.3" })).dir)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });
    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
  });

  test("keeps every sibling of a wrapper this installer wrote: that wrapper vouches for none of them", async () => {
    await writeProductionWrapperFixture();
    mkdirSync(join(wrapperDir, "native", PLATFORM_ARCH), { recursive: true });
    mkdirSync(join(wrapperDir, "fonts"), { recursive: true });
    writeFileSync(join(wrapperDir, "flywheel-bin"), "someone else's binary\n");
    writeFileSync(join(wrapperDir, "native", PLATFORM_ARCH, "libopentui.txt"), "someone else's library");
    writeFileSync(join(wrapperDir, "fonts", "monaspace.txt"), "someone else's font");

    const outcome = await install((await makePayload("first", { version: "1.2.3" })).dir);

    expect(readFileSync(outcome.wrapperPath, "utf-8")).toContain(userDataRoot);
    expect(readFileSync(join(wrapperDir, "flywheel-bin"), "utf-8")).toBe("someone else's binary\n");
    expect(readFileSync(join(wrapperDir, "native", PLATFORM_ARCH, "libopentui.txt"), "utf-8")).toBe("someone else's library");
    expect(readFileSync(join(wrapperDir, "fonts", "monaspace.txt"), "utf-8")).toBe("someone else's font");
  });

  test("a wrapper whose file only quotes the ownership marker is not this installer's to replace", async () => {
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "flywheel"), "#!/bin/sh\n# quoting # flywheel-owned-wrapper v1 proves nothing\necho someone else\n");

    await expect(install((await makePayload("first", { version: "1.2.3" })).dir)).rejects.toThrow("was not written by Flywheel");
    expect(existsSync(join(userDataRoot, "current"))).toBe(false);
  });

  test("a refusal at activation leaves the launcher it would have migrated whole", async () => {
    await install((await makePayload("newer", { version: "1.3.0" })).dir);

    const stale = join(home, "bin-stale");
    writeLegacyLayout(stale);
    const older = await makePayload("older", { version: "1.2.3" });

    await expect(install(older.dir, stale)).rejects.toThrow("activation must move forward");

    expect(readFileSync(join(stale, "flywheel"), "utf-8")).toBe(legacyWrapper);
    expect(readFileSync(join(stale, "flywheel-bin"), "utf-8")).toBe("#!/bin/sh\nexit 0\n");
    expect(existsSync(join(stale, "native", PLATFORM_ARCH, "libopentui.txt"))).toBe(true);
    expect(existsSync(join(stale, "fonts", "monaspace.txt"))).toBe(true);
  });
});

unixInstallation("the build current already names", () => {
  function bendCurrentTo(target: string): void {
    rmSync(join(userDataRoot, "current"));
    symlinkSync(target, join(userDataRoot, "current"));
  }

  test("a target that is not exactly two components under versions refuses the next activation", async () => {
    await install((await makePayload("first", { version: "1.2.3" })).dir);
    bendCurrentTo(join("versions", "1.2.3"));

    await expect(install((await makePayload("next", { version: "1.3.0" })).dir)).rejects.toThrow("is not an installed build directory");
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(join(userDataRoot, "versions", "1.2.3")));
  });

  test("metadata that describes another build refuses the next activation", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    writeFileSync(join(first.buildDir, "build.json"), `${JSON.stringify({ version: "1.2.4", buildId: first.buildId, asset: ASSET }, null, 2)}\n`);

    await expect(install((await makePayload("next", { version: "1.3.0" })).dir)).rejects.toMatchObject({ _tag: "Install", reason: expect.any(String) });
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(first.buildDir));
  });

  test("a changed active payload does not block a verified newer build", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    writeFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "tampered");

    const next = await install((await makePayload("next", { version: "1.3.0" })).dir);

    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(next.buildDir));
    expect(readFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "utf-8")).toBe("tampered");
  });

  test("a changed active payload does not block an explicit same-version rebuild", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    writeFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "tampered");

    const replacement = await install((await makePayload("replacement", { version: "1.2.3", mark: "rebuilt" })).dir);

    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(replacement.buildDir));
    expect(readFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "utf-8")).toBe("tampered");
  });

  test("a changed active payload cannot permit a downgrade", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    writeFileSync(join(first.buildDir, "fonts", "monaspace.txt"), "tampered");

    await expect(install((await makePayload("older", { version: "1.2.2" })).dir)).rejects.toThrow("activation must move forward");
    expect(realpathSync(join(userDataRoot, "current"))).toBe(realpathSync(first.buildDir));
  });

  test("the wrapper executes nothing when current is bent outside the versions path", async () => {
    const first = await install((await makePayload("first", { version: "1.2.3" })).dir);
    const planted = join(home, "planted");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "flywheel-bin"), "#!/bin/sh\necho planted code ran\n");
    chmodSync(join(planted, "flywheel-bin"), 0o755);
    bendCurrentTo(planted);

    const result = launchWrapper(first.wrapperPath);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("planted code ran");
    expect(result.stderr).toContain("does not name an installed build");
  });
});
