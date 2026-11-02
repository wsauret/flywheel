import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import * as path from "node:path";
import { AGENT_SESSION_ENV } from "../../../../../src/infra/cli-subprocess.js";

import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { makeMockOps, ownedSpawnProbe } from "./_bash-fixtures.js";
import { capabilityAccessHolding, makeContext } from "./_fixtures.js";
import { prepareMutationGitEnvironment } from "../../../../../src/orchestration/agent-runtime/tools/bash-git-wrapper.js";
import * as nativeAssets from "../../../../../src/infra/native-assets.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import type { BashOperations } from "../../../../../src/orchestration/agent-runtime/tools/types.js";

const createDirectory = temporaryDirectories();

/** Values that prove the launch environment is a full inherit of this
 *  process's environment, credentials included. Flywheel does not strip the
 *  model-controlled shell's environment; containment is the user's job
 *  (ARCH-TOOLS-039, PI-AGENT-046). */
const INHERITED = {
  ANTHROPIC_API_KEY: "inherit-proof-key",
  DATABASE_URL: "postgres://admin:inherit-proof@db.internal/app",
  MY_CUSTOM_SETTING: "inherit-proof-setting",
};

/** Sets (or deletes, for undefined values) the variables on this process for
 *  one launch and puts the runner's own environment back exactly as it was. A
 *  name that was absent is deleted again, never left holding the string
 *  "undefined". */
async function withEnv<T>(overrides: { [name: string]: string | undefined }, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>(
    Object.keys(overrides).map((name) => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined]),
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

describe("bash tool: launch environment", () => {
  // Command analysis fails closed while the parser is still loading, and the
  // parser is loaded once per process. Loading it here makes these cases
  // independent of whichever file in the shard happened to load it first.
  beforeAll(async () => { await loadBashParser(); });

  it.each(process.platform === "win32" ? ["win32"] as const : ["darwin", "win32"] as const)("prepares a separate %s Git environment without changing the normal Bun shim environment", (platform) => {
    const root = createDirectory("mutation-git-env-");
    const asset = path.join(root, "forwarder.exe");
    fs.writeFileSync(asset, "native-forwarder-fixture");
    const forwarder = spyOn(nativeAssets, "windowsGitForwarderPath").mockReturnValue(asset);
    const realGit = Bun.which("git");
    expect(realGit).not.toBeNull();
    const original = platform === "win32"
      ? { Path: path.dirname(realGit ?? ""), KEEP: "inherited" }
      : { PATH: path.dirname(realGit ?? ""), Path: "posix-does-not-use-this", KEEP: "inherited" };
    const before = { ...original };
    try {
      const scratchDir = path.join(root, "scratch");
      const env = prepareMutationGitEnvironment({ env: original, cwd: root, scratchDir, platform, execPath: process.execPath });
      const pathKey = platform === "win32" ? "Path" : "PATH";
      const wrapper = env[pathKey]?.split(platform === "win32" ? ";" : ":")[0] ?? "";
      expect(original).toEqual(before);
      expect(env.KEEP).toBe("inherited");
      expect(env.FLYWHEEL_MUTATION_GIT_REAL).toBe(realGit ?? "");
      expect(env.FLYWHEEL_MUTATION_GIT_SOURCE).toEndWith(`${path.sep}src${path.sep}cli${path.sep}index.ts`);
      expect(env[pathKey]).toEndWith(before[pathKey] ?? "");
      const executable = path.join(wrapper, platform === "win32" ? "git.exe" : "git");
      expect(fs.existsSync(executable)).toBe(true);
      if (platform === "win32") {
        expect(Object.hasOwn(env, "PATH")).toBe(false);
        expect(fs.readFileSync(executable)).toEqual(fs.readFileSync(asset));
      } else {
        expect(env.Path).toBe("posix-does-not-use-this");
        expect(fs.statSync(executable).mode & 0o100).toBe(0o100);
      }
      // Every command of the session on one runtime shares the installed folder and writes nothing in it.
      const folderEntries = () => [wrapper, ...fs.readdirSync(wrapper).map((name) => path.join(wrapper, name))];
      const entries = folderEntries();
      for (const entry of entries) fs.utimesSync(entry, new Date(1_000_000), new Date(1_000_000));
      const second = prepareMutationGitEnvironment({ env: original, cwd: root, scratchDir, platform, execPath: process.execPath });
      expect(second[pathKey]).toBe(env[pathKey] ?? "");
      expect(folderEntries()).toEqual(entries);
      for (const entry of entries) expect(fs.statSync(entry).mtimeMs).toBe(1_000_000);
      // Another runtime gets its own folder: on Windows the forwarder identifies it, elsewhere the shim's runtime.
      if (platform === "win32") {
        const otherAsset = path.join(root, "other-forwarder.exe");
        fs.writeFileSync(otherAsset, "other-forwarder-fixture");
        forwarder.mockReturnValue(otherAsset);
      }
      const otherExecPath = platform === "win32" ? process.execPath : path.join(root, "other-runtime", "flywheel");
      const other = prepareMutationGitEnvironment({ env: original, cwd: root, scratchDir, platform, execPath: otherExecPath });
      expect(path.dirname(other[pathKey]?.split(platform === "win32" ? ";" : ":")[0] ?? "")).toBe(path.dirname(wrapper));
      expect(other[pathKey]).not.toBe(env[pathKey]);
    } finally {
      forwarder.mockRestore();
    }
  });

  interface LaunchOptions {
    scratchDir?: string;
    execPath?: string;
    platform?: "darwin" | "win32";
    env?: { [name: string]: string | undefined };
    background?: boolean;
    loginShellPath?: string;
    operations?: BashOperations;
  }

  const launchEnv = async (command: string, options: LaunchOptions = {}) =>
    withEnv({ ...INHERITED, ...options.env }, async () => {
      const spawn = ownedSpawnProbe();
      const def = createBashDefinition({
        execPath: options.execPath ?? "/usr/local/bin/bun",
        operations: options.operations ?? makeMockOps(),
        ...(options.platform ? { platform: options.platform } : {}),
        loginShellPath: () => options.loginShellPath,
      });
      const context = makeContext({
        executionCwd: "/mock",
        sessionId: "s1",
        spawnOwned: spawn.spawnOwned,
        // One of these commands is backgrounded, which is an optional capability.
        capabilityAccess: capabilityAccessHolding(["background-commands"]),
        ...(options.background ? { backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }) } : {}),
        ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
      });

      const result = await def.execute({ command, ...(options.background ? { background: true } : {}) }, context);

      expect(result.outcome).toBe("ok");
      const env = spawn.launches[0]?.env;
      expect(env).toBeDefined();
      return env ?? {};
    });

  it("launches a foreground command with exactly the full process environment and the session that runs it", async () => {
    const env = await launchEnv("echo hi");

    // The process environment unfiltered, plus the one marker that keeps a
    // Flywheel client the command starts from replacing the account service.
    expect(env).toEqual({ ...process.env, ...INHERITED, [AGENT_SESSION_ENV]: "s1" });
  });

  it("launches a background command with the full process environment", async () => {
    const env = await launchEnv("sleep 5", { background: true });

    for (const [name, value] of Object.entries(INHERITED)) expect(env[name]).toBe(value);
  });

  it("prefixes the scratchpad shim onto PATH and keeps the rest of the environment", async () => {
    const scratchDir = "/proj/.flywheel/sessions/s1/scratch";
    const env = await launchEnv("bun scratch.ts", { scratchDir, execPath: "/opt/flywheel/flywheel" });
    const pathEntry = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH");

    expect(pathEntry?.[1]?.startsWith(path.join(scratchDir, "bin") + path.delimiter)).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe(INHERITED.ANTHROPIC_API_KEY);
  });

  /** A login shell PATH whose first folder holds `grep` and `find` and no other search program. */
  function searchProgramsPath(): string {
    const programs = createDirectory("search-programs-");
    for (const name of ["grep", "find"]) {
      fs.writeFileSync(path.join(programs, name), "#!/bin/sh\n");
      fs.chmodSync(path.join(programs, name), 0o755);
    }
    return `${programs}${path.delimiter}${path.join(programs, "missing")}`;
  }

  // Bun.which resolves a Windows program only by its PATHEXT extension.
  it.skipIf(process.platform === "win32")("starts the PATH with the scratchpad shim, then the search shims of the programs that the login shell PATH holds, then that PATH", async () => {
    const scratchDir = "/proj/.flywheel/sessions/s1/scratch";
    const loginShellPath = searchProgramsPath();
    const written: string[] = [];
    const env = await launchEnv("gh --version", {
      scratchDir,
      execPath: "/opt/flywheel/flywheel",
      loginShellPath,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      operations: makeMockOps({ writeExecutable: async (file) => { written.push(file); } }),
    });
    const [bunShim, searchShims = "", ...rest] = env.PATH?.split(path.delimiter) ?? [];

    expect(bunShim).toBe(path.join(scratchDir, "bin"));
    expect(path.dirname(searchShims)).toBe(path.join(scratchDir, "search-shims"));
    expect(rest.join(path.delimiter)).toBe(loginShellPath);
    expect(written.filter((file) => path.dirname(file) === searchShims).map((file) => path.basename(file)).sort()).toEqual(["find", "grep"]);
    expect(env.ANTHROPIC_API_KEY).toBe(INHERITED.ANTHROPIC_API_KEY);
  });

  it("installs no search shims on Windows", async () => {
    const scratchDir = "C:\\proj\\scratch";
    const loginShellPath = searchProgramsPath();
    const written: string[] = [];
    const env = await launchEnv("gh --version", {
      scratchDir,
      execPath: "C:\\flywheel\\flywheel.exe",
      platform: "win32",
      loginShellPath,
      operations: makeMockOps({ writeExecutable: async (file) => { written.push(file); } }),
    });

    expect(Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]).toBe(`${path.join(scratchDir, "bin")}${path.delimiter}${loginShellPath}`);
    expect(written).toEqual([path.join(scratchDir, "bin", "bun.cmd")]);
  });

  it("uses the login shell PATH in place of the process PATH when no shim is installed", async () => {
    const loginShellPath = "/opt/homebrew/bin:/usr/bin:/bin";
    const env = await launchEnv("gh --version", { loginShellPath, env: { PATH: "/usr/bin:/bin" } });

    expect(Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1]).toBe(loginShellPath);
  });

  it("uses the shim directory alone when the process has no PATH", async () => {
    const scratchDir = "/proj/.flywheel/sessions/s1/scratch";
    const env = await launchEnv("bun scratch.ts", {
      scratchDir,
      execPath: "/opt/flywheel/flywheel",
      env: { PATH: undefined },
    });

    expect(env.PATH).toBe(path.join(scratchDir, "bin"));
  });

  // The premise is a Windows-cased key on a POSIX host, where environment names
  // are case-sensitive and "Path" is a different variable from "PATH". Windows
  // folds the two into one, so there is no separate key to leave untouched.
  it.skipIf(process.platform === "win32")("does not touch a Windows-cased Path key on POSIX", async () => {
    const scratchDir = "/proj/.flywheel/sessions/s1/scratch";
    const env = await launchEnv("bun scratch.ts", {
      scratchDir,
      execPath: "/opt/flywheel/flywheel",
      env: { Path: "C:\\bin" },
    });

    expect(env.Path).toBe("C:\\bin");
    expect(env.PATH?.startsWith(path.join(scratchDir, "bin") + path.delimiter)).toBe(true);
  });

  it("overrides the existing Path casing on Windows rather than adding a second key", async () => {
    const scratchDir = "C:\\proj\\scratch";
    const env = await launchEnv("bun scratch.ts", {
      scratchDir,
      execPath: "C:\\flywheel\\flywheel.exe",
      platform: "win32",
      env: { PATH: undefined, Path: "C:\\bin" },
    });

    expect(env.Path).toBe(`${path.join(scratchDir, "bin")}${path.delimiter}C:\\bin`);
    expect(env.PATH).toBeUndefined();
  });
});
