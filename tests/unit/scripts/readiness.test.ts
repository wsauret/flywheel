import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { RELEASE_ARCHIVES, RELEASE_BUILD_COMMANDS, RELEASE_TARGETS } from "../../../scripts/release-contract.js";
import { dockerRuntimeCommand, readinessPlan, releaseLoginContainerCommand, releaseLoginStatusContainerCommand } from "../../../scripts/readiness-plan.js";
import { readinessCommandTimeout, runReadiness, type CommandEnvironment, type ReadinessDependencies } from "../../../scripts/readiness.js";

const ROOT = resolve("/repo");
const BUN = "/bun";
const HARNESS = join(ROOT, "scripts", "readiness-package-smoke.ts");

/** A tokenizer manifest: source identity every host reproduces, plus the bytes
 *  only the committing host reproduces. */
const manifest = (source: string, wasmSha: string) => JSON.stringify({
  version: 2,
  sourceSha256: source,
  cargo: { tomlSha256: "toml", lockSha256: "lock" },
  artifact: { compressedSha256: "compressed", compressedBytes: 10, wasmSha256: wasmSha, wasmBytes: 20 },
});
const COMMITTED_TOKENIZER = manifest("source", "mac-bytes");

const SDK = "@anthropic-ai/claude-agent-sdk";
/** A lockfile that pins the Agent SDK at `version`. */
const lock = (version: string) => JSON.stringify({ lockfileVersion: 1, packages: { [SDK]: [`${SDK}@${version}`, "", {}, "sha512-sdk"] } });
const RELEASE_TAG = "v0.0.12";
/** The git reads of the engine bump: the last release tag and the lockfile at HEAD and at that tag. */
const ENGINE_BUMP_READS = [["git", "describe", "--tags", "--abbrev=0", "--match", "v*"], ["git", "show", "HEAD:bun.lock"], ["git", "show", `${RELEASE_TAG}:bun.lock`]];

/** The account home of the fake host, whose live profile the live tier reads when no release login home is set. */
const ACCOUNT_HOME = resolve("/home/person");
/** What the fake status mode answers for every home and volume, unless a test gives another answer. */
const PRESENT = { exitCode: 0, stdout: "present file\n", stderr: "" };
const isStatusRead = (command: readonly string[]) => command.includes("--status");
/** The auth profile that the live auth profile setting names, unless a scenario leaves it unset. */
const PROFILE = "Live";

interface Scenario {
  readonly shipped?: string;
  readonly pinned?: string;
  readonly quick?: boolean;
  /** The release login home that the readiness setting names. */
  readonly releaseLoginHome?: string;
  /** Leaves the live auth profile setting unset. */
  readonly noLiveAuthProfile?: true;
}

/** Runs readiness on fake dependencies. Git answers the engine bump's reads from `scenario`, which by default pins the
 *  SDK that the last release shipped, and every login status read answers present; every other command goes to
 *  `overrides.run` when a test gives one. Each command's added environment is kept beside it. */
function orchestrate(platform: string, arch: string, overrides: Partial<ReadinessDependencies> = {}, scenario: Scenario = {}) {
  const commands: string[][] = [];
  const environments = new Map<string, CommandEnvironment>();
  const engineRead = (command: readonly string[]) => {
    if (command[0] !== "git") return undefined;
    if (command[1] === "describe") return { exitCode: 0, stdout: `${RELEASE_TAG}\n`, stderr: "" };
    if (command[1] === "show" && command[2] === "HEAD:bun.lock") return { exitCode: 0, stdout: lock(scenario.pinned ?? "0.3.296"), stderr: "" };
    if (command[1] === "show" && command[2] === `${RELEASE_TAG}:bun.lock`) return { exitCode: 0, stdout: lock(scenario.shipped ?? "0.3.296"), stderr: "" };
    return undefined;
  };
  const run: ReadinessDependencies["run"] = overrides.run ?? ((command) => {
    if (isStatusRead(command)) return PRESENT;
    if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
    return { exitCode: 0, stdout: command[0] === "/docker" && command[1] === "info" ? "Server Version: 27" : "", stderr: "" };
  });
  const dependencies: ReadinessDependencies = {
    exists: () => true,
    which: (name) => name === "docker" ? "/docker" : name === "tmux" ? "/tmux" : undefined,
    readText: () => COMMITTED_TOKENIZER,
    log: () => undefined,
    ...overrides,
    run: (command, env) => {
      commands.push([...command]);
      if (env !== undefined) environments.set(command.join(" "), env);
      return engineRead(command) ?? run(command, env);
    },
  };
  const outcome = runReadiness({
    root: ROOT, platform, arch, quick: scenario.quick ?? false, bunExecutable: BUN, bunVersion: "1.3.14", version: "0.0.8",
    accountHome: ACCOUNT_HOME, releaseLoginHome: scenario.releaseLoginHome, liveAuthProfile: scenario.noLiveAuthProfile ? undefined : PROFILE,
  }, dependencies);
  return { commands, environments, outcome };
}

/** A host on which every login status read prints `line` and every other command passes. */
const statusAnswering = (line: string): ReadinessDependencies["run"] => (command) => {
  if (isStatusRead(command)) return { exitCode: 0, stdout: line, stderr: "" };
  if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
  return { exitCode: 0, stdout: "", stderr: "" };
};
const check = (outcome: ReturnType<typeof orchestrate>["outcome"], name: string) => outcome.checks.find((entry) => entry.name === name);
const LIVE_TIER = [BUN, "run", "test:integration:claude-engine"];
const hostStatus = (home: string) => [BUN, "run", "scripts/readiness-login.ts", "--status", home];
const LINUX_STATUS = releaseLoginStatusContainerCommand({ dockerPlatform: "linux/arm64", root: ROOT, bunVersion: "1.3.14", liveAuthProfile: PROFILE }).map((part, index) => index === 0 ? "/docker" : part);
const linuxLive = (candidate: string) => releaseLoginContainerCommand({ dockerPlatform: "linux/arm64", bunVersion: "1.3.14", candidate, liveAuthProfile: PROFILE, step: "live" }).map((part, index) => index === 0 ? "/docker" : part);
const LINUX_LIVE = linuxLive("/scratch/candidate.tar");
const isLinuxLive = (command: readonly string[]) => command[0] === "/docker" && command.join(" ").includes("test:integration:claude-engine");
/** The candidate tar that the Linux live tier's `git archive` writes. */
const candidateOf = (commands: readonly (readonly string[])[]) => commands.find((command) => command[1] === "archive")?.find((part) => part.startsWith("--output="))?.slice("--output=".length);

describe("deployment readiness planning", () => {
  test("derives macOS builds and Linux evidence from the canonical matrix", () => {
    const plan = readinessPlan("darwin", "arm64", false, { tmux: true });
    expect(plan.builds.map((build) => build.target)).toEqual(RELEASE_TARGETS);
    expect(plan.builds.map((build) => build.archive)).toEqual(RELEASE_ARCHIVES);
    expect(plan.builds.map((build) => build.command)).toEqual(RELEASE_BUILD_COMMANDS);
    expect(plan.linuxRuntime.map(({ target, dockerImageSuffix, evidence }) => ({ target, dockerImageSuffix, evidence }))).toEqual([
      { target: "linux-arm64", dockerImageSuffix: "", evidence: "native container functional evidence" },
      { target: "linux-arm64-musl", dockerImageSuffix: "-alpine", evidence: "native container functional evidence" },
      { target: "linux-x64", dockerImageSuffix: "", evidence: "emulated container functional evidence" },
      { target: "linux-x64-musl", dockerImageSuffix: "-alpine", evidence: "emulated container functional evidence" },
    ]);
  });

  test("constructs Docker runtime commands with the exact host Bun version", () => {
    expect(dockerRuntimeCommand({ target: "linux-x64", dockerPlatform: "linux/amd64", dockerImageSuffix: "", archive: join(ROOT, "dist", "flywheel-linux-x64.tar.gz"), harness: HARNESS, tokenizerManifest: join(ROOT, "crates", "tokenizer", "tokenizer-prebuilt.json"), version: "0.0.8", bunVersion: "1.3.14" })).toEqual([
      "docker", "run", "--rm", "--platform=linux/amd64", "--network=none",
      "--mount", `type=bind,source=${join(ROOT, "dist", "flywheel-linux-x64.tar.gz")},target=/input/archive.tar.gz,readonly`,
      "--mount", `type=bind,source=${HARNESS},target=/input/readiness-package-smoke.ts,readonly`,
      "--mount", `type=bind,source=${join(ROOT, "crates", "tokenizer", "tokenizer-prebuilt.json")},target=/input/tokenizer-prebuilt.json,readonly`,
      "oven/bun:1.3.14", "bun", "run", "/input/readiness-package-smoke.ts",
      "--archive", "/input/archive.tar.gz", "--target", "linux-x64", "--expected-version", "0.0.8", "--tokenizer-manifest", "/input/tokenizer-prebuilt.json",
    ]);
  });

  test("bounds hermetic Docker probes and leaves every repository command to its own hang guards", () => {
    expect(readinessCommandTimeout(["/docker", "run", "--rm", "--network=none", "image"], "/docker")).toBe(180_000);
    expect(readinessCommandTimeout(LINUX_STATUS, "/docker")).toBe(180_000);
    // The live tier in a container is the repository's own integration script, behind its own budgets.
    expect(readinessCommandTimeout(LINUX_LIVE, "/docker")).toBeUndefined();
    expect(readinessCommandTimeout([BUN, "run", "build"], "/docker")).toBeUndefined();
    expect(readinessCommandTimeout([BUN, "run", "test:integration:no-api"], "/docker")).toBeUndefined();
  });
});

describe("readiness orchestration", () => {
  test("runs complete macOS arm64 readiness in exact order without mutation or publication", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64");
    const archives = RELEASE_ARCHIVES.map((archive) => join(ROOT, "dist", archive));
    expect(commands).toEqual([
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      [BUN, "run", "check:commits", "--upstream", "--head", "HEAD"],
      ...ENGINE_BUMP_READS,
      [BUN, "install", "--frozen-lockfile", "--dry-run"], [BUN, "run", "check:claude-engine"], [BUN, "run", "lint"], [BUN, "run", "check:boundaries"], [BUN, "run", "scripts/build-native-addon.ts", "--crate=ripgrep", "--verify"], [BUN, "run", "test"], [BUN, "run", "test:integration:no-api"],
      [BUN, "run", "build:tokenizer"],
      ["git", "show", "HEAD:crates/tokenizer/tokenizer-prebuilt.json"],
      ["git", "checkout", "--", "crates/tokenizer"],
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      [BUN, "run", "build:tokenizer", "--verify"],
      ...RELEASE_BUILD_COMMANDS.map((command) => [BUN, ...command.slice(1)]),
      [BUN, "run", HARNESS, "--addon", join(ROOT, "dist", "flywheel-darwin-arm64", "build", "native", "darwin-arm64", "flywheel-ripgrep.darwin-arm64.node"), "--target", "darwin-arm64"],
      [BUN, "run", HARNESS, "--planners", "--target", "darwin-arm64"],
      [BUN, "run", "scripts/verify-production-composition.ts", "--binary", join(ROOT, "dist", "flywheel-darwin-arm64", "build", "flywheel-bin")],
      [BUN, "run", "test:perf", "--archive", archives[0]!],
      [BUN, "run", HARNESS, "--archive", archives[0]!, "--target", "darwin-arm64", "--expected-version", "0.0.8"], ["/docker", "info"],
      ...(["linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl"] as const).map((target) => dockerRuntimeCommand({
        target,
        dockerPlatform: target.startsWith("linux-arm64") ? "linux/arm64" : "linux/amd64",
        dockerImageSuffix: target.endsWith("-musl") ? "-alpine" : "",
        archive: join(ROOT, "dist", `flywheel-${target}.tar.gz`),
        harness: HARNESS,
        tokenizerManifest: join(ROOT, "crates", "tokenizer", "tokenizer-prebuilt.json"),
        version: "0.0.8",
        bunVersion: "1.3.14",
      }).map((part, index) => index === 0 ? "/docker" : part)),
    ]);
    expect(outcome.exitCode).toBe(0);
    // Reading the last release tag is evidence; creating a tag is publication.
    expect(commands.map((command) => command.join(" ")).join("\n")).not.toMatch(/(?:^|\s)release|publish|push|^git tag|models:snapshot|install:local/mu);
  });

  test("runs complete Windows host-capable readiness in exact order", () => {
    const { commands, outcome } = orchestrate("win32", "x64");
    expect(commands).toEqual([
      ["git", "status", "--porcelain=v1", "--untracked-files=all"], [BUN, "run", "check:commits", "--upstream", "--head", "HEAD"],
      ...ENGINE_BUMP_READS,
      [BUN, "install", "--frozen-lockfile", "--dry-run"], [BUN, "run", "check:claude-engine"], [BUN, "run", "lint"], [BUN, "run", "check:boundaries"], [BUN, "run", "scripts/build-native-addon.ts", "--crate=ripgrep", "--verify"], [BUN, "run", "test"], [BUN, "run", "test:integration:no-api"],
      [BUN, "run", "build:tokenizer"],
      ["git", "show", "HEAD:crates/tokenizer/tokenizer-prebuilt.json"],
      ["git", "checkout", "--", "crates/tokenizer"],
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      [BUN, "run", "build:tokenizer", "--verify"],
      [BUN, "run", "scripts/build-binary.ts", "--target=bun-windows-x64", "--native-provenance=source-build", "--release"],
      [BUN, "run", HARNESS, "--addon", join(ROOT, "dist", "flywheel-win32-x64", "build", "native", "win32-x64", "flywheel-ripgrep.win32-x64.node"), "--target", "win32-x64"],
      [BUN, "run", HARNESS, "--planners", "--target", "win32-x64"],
      [BUN, "run", "scripts/verify-production-composition.ts", "--binary", join(ROOT, "dist", "flywheel-win32-x64", "build", "flywheel-bin.exe")],
      [BUN, "run", "test:perf", "--archive", join(ROOT, "dist", "flywheel-win32-x64.tar.gz")],
      [BUN, "run", HARNESS, "--archive", join(ROOT, "dist", "flywheel-win32-x64.tar.gz"), "--target", "win32-x64", "--expected-version", "0.0.8"],
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.checks.filter(({ status }) => status === "skip").map(({ name }) => name)).toEqual(["Claude engine live qualification", "agent-observed live TUI UAT"]);
    expect(outcome.checks.find(({ name }) => name === "Claude engine live qualification")?.detail).toBe(`${RELEASE_TAG} already shipped ${SDK} 0.3.296`);
  });

  test("owes the performance gate wherever tmux answers, and names the tool a host lacks", () => {
    expect(readinessPlan("win32", "x64", false, { tmux: true }).performance).toBe("required");
    const withoutTmux = readinessPlan("win32", "x64", false, { tmux: false });
    expect(withoutTmux.performance).toBe("unavailable");
    expect(withoutTmux.unavailable).toEqual(["performance gate: tmux is unavailable; install psmux, which provides tmux on Windows"]);
    expect(readinessPlan("linux", "x64", false, { tmux: false }).unavailable).toEqual(["performance gate: tmux is unavailable; install tmux"]);

    const noTmux = orchestrate("win32", "x64", { which: () => undefined });
    expect(noTmux.commands.some((command) => command.includes("test:perf"))).toBe(false);
    expect(noTmux.outcome.checks.find(({ name }) => name === "performance gate")).toEqual({ name: "performance gate", status: "skip", detail: "performance gate: tmux is unavailable; install psmux, which provides tmux on Windows" });
  });

  test("fails dirty trees and failed required checks", () => {
    expect(orchestrate("win32", "x64", { run: (command) => ({ exitCode: 0, stdout: command[0] === "git" ? "?? new-file" : "", stderr: "" }) }).outcome.exitCode).toBe(1);
    expect(orchestrate("win32", "x64", { run: (command) => ({ exitCode: command.includes("check:commits") ? 2 : 0, stdout: "", stderr: "bad commit" }) }).outcome.exitCode).toBe(1);
  });

  test("rebuilds the tokenizer exactly once and refuses generated changes before matrix builds", () => {
    let statusCalls = 0;
    let tokenizerRebuilds = 0;
    let matrixBuilds = 0;
    const { outcome } = orchestrate("darwin", "arm64", {
      run: (command) => {
        if (command[0] === "git" && command[1] === "status") statusCalls += 1;
        if (command.join(" ") === `${BUN} run build:tokenizer`) tokenizerRebuilds += 1;
        if (command.includes("scripts/build-binary.ts")) matrixBuilds += 1;
        if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
        return { exitCode: 0, stdout: statusCalls === 2 ? " M generated/output.txt" : "", stderr: "" };
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(tokenizerRebuilds).toBe(1);
    expect(matrixBuilds).toBe(0);
  });

  test("accepts a rebuild whose bytes differ from the committed artifact on this host", () => {
    // Every host compiles one source into its own byte string, so the bytes are
    // the committing host's property. Only the identity must agree.
    let matrixBuilds = 0;
    const { outcome } = orchestrate("win32", "x64", {
      readText: () => manifest("source", "windows-bytes"),
      run: (command) => {
        if (command.includes("scripts/build-binary.ts")) matrixBuilds += 1;
        if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(outcome.checks.find(({ name }) => name === "committed tokenizer matches its source")?.status).toBe("pass");
    expect(matrixBuilds).toBeGreaterThan(0);
  });

  test("refuses a committed tokenizer that no longer matches its source", () => {
    let matrixBuilds = 0;
    const { outcome } = orchestrate("win32", "x64", {
      readText: () => manifest("rebuilt-from-newer-source", "windows-bytes"),
      run: (command) => {
        if (command.includes("scripts/build-binary.ts")) matrixBuilds += 1;
        if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.checks.find(({ name }) => name === "committed tokenizer matches its source")?.status).toBe("fail");
    expect(matrixBuilds).toBe(0);
  });

  test("reports a missing pinned wasm target as an unavailable rebuild prerequisite", () => {
    const { outcome } = orchestrate("darwin", "arm64", {
      run: (command) => command.join(" ") === `${BUN} run build:tokenizer`
        ? { exitCode: 1, stdout: "", stderr: "Required rustup target wasm32-wasip1 is unavailable for 1.85.0" }
        : { exitCode: 0, stdout: "", stderr: "" },
    });
    expect(outcome.checks.find(({ name }) => name === "tokenizer rebuild")?.status).toBe("blocked");
    expect(outcome.checks.find(({ name }) => name === "tokenizer rebuild")?.detail).toContain("unavailable rebuild prerequisite");
  });

  test("blocks Docker checks with diagnostic-specific guidance", () => {
    const socket = orchestrate("darwin", "arm64", { run: (command) => {
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return command[1] === "info" ? { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } : { exitCode: 0, stdout: "", stderr: "" };
    } });
    expect(socket.outcome.exitCode).toBe(1);
    expect(socket.outcome.checks.some(({ status, detail }) => status === "blocked" && detail.includes("start Docker Desktop"))).toBe(true);
    const permission = orchestrate("darwin", "arm64", { run: (command) => {
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return command[1] === "info" ? { exitCode: 1, stdout: "", stderr: "permission denied while trying to connect" } : { exitCode: 0, stdout: "", stderr: "" };
    } });
    expect(permission.outcome.checks.some(({ status, detail }) => status === "blocked" && detail.includes("permission denied while trying to connect"))).toBe(true);
    expect(permission.outcome.checks.at(-2)?.detail).not.toContain("start Docker Desktop");
  });

  test("reports the Claude engine pin's freshness, and an unanswered registry as blocked", () => {
    const report = { exitCode: 0, stdout: `claude engine: ${SDK} 0.3.296 (engine 2.1.296), published 2026-10-09, 0 days old\nclaude engine: newest 0.3.296 (engine 2.1.296), 0 releases behind\n`, stderr: "" };
    const freshness = (exitCode: number) => orchestrate("win32", "x64", { run: (command) => command.includes("check:claude-engine") ? { ...report, exitCode } : { exitCode: 0, stdout: "", stderr: "" } }, { quick: true }).outcome;
    expect(freshness(0).checks.find(({ name }) => name === "Claude engine freshness")).toEqual({
      name: "Claude engine freshness", status: "pass", detail: `${SDK} 0.3.296 (engine 2.1.296), published 2026-10-09, 0 days old; newest 0.3.296 (engine 2.1.296), 0 releases behind`,
    });
    expect([freshness(1), freshness(3)].map(({ exitCode, checks }) => [exitCode, checks.find(({ name }) => name === "Claude engine freshness")?.status])).toEqual([[1, "fail"], [1, "blocked"]]);
  });

  test("on a bump, checks the host's login in the live profile before the long gates and runs only the Claude engine live file after the no-api tier", () => {
    const bumped = orchestrate("win32", "x64", {}, { shipped: "0.3.295" });
    const contract = bumped.commands.findIndex((command) => command.includes("check:commits"));
    expect(bumped.commands.slice(contract + 1, contract + 5)).toEqual([...ENGINE_BUMP_READS, hostStatus(ACCOUNT_HOME)]);
    const integration = bumped.commands.findIndex((command) => command.includes("test:integration:no-api"));
    expect(bumped.commands[integration + 1]).toEqual(LIVE_TIER);
    expect(bumped.commands.some((command) => command.includes("test:integration:api"))).toBe(false);
    // Without the setting, the tier reads the account's own home.
    expect(bumped.environments.has(LIVE_TIER.join(" "))).toBe(false);
    expect(check(bumped.outcome, "Claude engine live login")).toEqual({ name: "Claude engine live login", status: "pass", detail: `the account home ${ACCOUNT_HOME} holds a Claude login in the auth profile "Live", with its token in the credentials file` });
    expect(bumped.outcome.exitCode).toBe(0);
  });

  test("runs the live tier, and only the live tier, on the release login home that the setting names", () => {
    const home = resolve("/users/person/AppData/Local/FlywheelReadiness");
    const bumped = orchestrate("win32", "x64", {}, { shipped: "0.3.295", releaseLoginHome: home });
    expect(bumped.commands).toContainEqual(hostStatus(home));
    expect(bumped.commands).not.toContainEqual(hostStatus(ACCOUNT_HOME));
    expect([...bumped.environments]).toEqual([[LIVE_TIER.join(" "), { HOME: home }]]);
    expect(bumped.outcome.exitCode).toBe(0);
  });

  test("blocks the live tier at once, with the command that logs in, when the home holds no usable login", () => {
    const absent = statusAnswering("absent\n");
    const release = orchestrate("win32", "x64", { run: absent }, { shipped: "0.3.295", releaseLoginHome: resolve("/release") });
    expect(release.commands).not.toContainEqual(LIVE_TIER);
    expect(release.outcome.exitCode).toBe(1);
    // The verdict comes before the long gates, so the person can log in while the pass runs.
    const names = release.outcome.checks.map(({ name }) => name);
    expect(names.indexOf("Claude engine live qualification")).toBeLessThan(names.indexOf("lint"));
    expect(check(release.outcome, "Claude engine live qualification")).toEqual({
      name: "Claude engine live qualification", status: "blocked",
      // The helper logs in to one folder of the real profile, so the remedy names it.
      detail: `${SDK} 0.3.295 in ${RELEASE_TAG} is now 0.3.296; the release login home ${resolve("/release")} holds no Claude login with a stored token in the auth profile "Live": run \`bun run readiness:login windows\` (run it on the release machine, with FLYWHEEL_READINESS_WINDOWS_HOST naming the SSH host of this machine); it logs in to %LOCALAPPDATA%\\FlywheelReadiness of the real profile, so FLYWHEEL_READINESS_CLAUDE_HOME must name that folder`,
    });

    const own = orchestrate("win32", "x64", { run: absent }, { shipped: "0.3.295" });
    expect(check(own.outcome, "Claude engine live qualification")?.detail).toEndWith(`the account home ${ACCOUNT_HOME} holds no Claude login with a stored token in the auth profile "Live": run \`FLYWHEEL_AUTH_PROFILE=Live flywheel auth login --claude-agent-sdk\``);
    const linux = orchestrate("linux", "x64", { run: absent }, { shipped: "0.3.295", releaseLoginHome: resolve("/release") });
    expect(check(linux.outcome, "Claude engine live qualification")?.detail).toEndWith(`run \`bun run readiness:login --in-home ${resolve("/release")}\``);
  });

  test("on a bump without the live auth profile setting, blocks the live tier at once with the setting's name and reads no login", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64", {}, { shipped: "0.3.295", noLiveAuthProfile: true });
    expect(commands.some(isStatusRead)).toBe(false);
    expect(commands).not.toContainEqual(LIVE_TIER);
    expect(commands.some(isLinuxLive)).toBe(false);
    expect(check(outcome, "Claude engine live qualification")).toEqual({
      name: "Claude engine live qualification", status: "blocked",
      detail: `${SDK} 0.3.295 in ${RELEASE_TAG} is now 0.3.296; FLYWHEEL_LIVE_AUTH_PROFILE is unset: set it to the auth profile whose accounts the live provider tests and the live Claude engine tier run on`,
    });
    expect(outcome.exitCode).toBe(1);
  });

  test("runs the live tier when the token store could not be searched, and states why", () => {
    const unchecked = statusAnswering("unchecked the login keychain is locked\n");
    const { commands, outcome } = orchestrate("win32", "x64", { run: unchecked }, { shipped: "0.3.295" });
    expect(commands).toContainEqual(LIVE_TIER);
    expect(check(outcome, "Claude engine live login")).toEqual({ name: "Claude engine live login", status: "skip", detail: `the account home ${ACCOUNT_HOME}: its token was not checked, because the login keychain is locked; the live tier decides` });
    expect(outcome.exitCode).toBe(0);
  });

  test("on a Mac bump, qualifies the engine on Linux in a container on the release login volume, right after the host's live tier", () => {
    let folderDuringRun: boolean | undefined;
    const { commands, outcome } = orchestrate("darwin", "arm64", { run: (command) => {
      const mounted = isLinuxLive(command) ? /source=([^,]+),target=\/input\/candidate\.tar/u.exec(command.join(" "))?.[1] : undefined;
      if (mounted !== undefined) folderDuringRun = existsSync(dirname(mounted));
      if (isStatusRead(command)) return PRESENT;
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } }, { shipped: "0.3.295" });
    const contract = commands.findIndex((command) => command.includes("check:commits"));
    expect(commands.slice(contract + 1, contract + 6)).toEqual([...ENGINE_BUMP_READS, hostStatus(ACCOUNT_HOME), LINUX_STATUS]);
    // The tar is written in a temporary folder of its own, which exists while the container reads it and is gone after.
    const candidate = candidateOf(commands);
    expect(candidate).toBeDefined();
    expect(dirname(candidate!)).toStartWith(join(tmpdir(), "flywheel-readiness-candidate-"));
    expect(folderDuringRun).toBe(true);
    expect(existsSync(dirname(candidate!))).toBe(false);
    const live = commands.findIndex((command) => command.join(" ") === LIVE_TIER.join(" "));
    expect(commands.slice(live, live + 4)).toEqual([LIVE_TIER, ["/docker", "info"], ["git", "archive", "--format=tar", `--output=${candidate}`, "HEAD"], linuxLive(candidate!)]);
    expect(check(outcome, "linux-arm64 Claude engine live login")?.status).toBe("pass");
    expect(check(outcome, "linux-arm64 Claude engine live qualification")).toEqual({ name: "linux-arm64 Claude engine live qualification", status: "pass", detail: "" });
    expect(outcome.exitCode).toBe(0);
  });

  test("keeps the Linux live qualification when the pass stops before its builds", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64", { run: (command) => {
      if (command.join(" ") === `${BUN} run build:tokenizer`) return { exitCode: 1, stdout: "", stderr: "cargo exited 101" };
      if (isStatusRead(command)) return PRESENT;
      return { exitCode: 0, stdout: "", stderr: "" };
    } }, { shipped: "0.3.295" });
    expect(check(outcome, "tokenizer rebuild")?.status).toBe("fail");
    expect(commands.some(isLinuxLive)).toBe(true);
    expect(check(outcome, "linux-arm64 Claude engine live qualification")?.status).toBe("pass");
    expect(existsSync(dirname(candidateOf(commands)!))).toBe(false);
  });

  test("blocks the Linux live qualification with Docker's reason when Docker stops answering before the tier", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64", { run: (command) => {
      if (command[0] === "/docker" && command[1] === "info") return { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" };
      if (isStatusRead(command)) return PRESENT;
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } }, { shipped: "0.3.295" });
    expect(commands.some(isLinuxLive)).toBe(false);
    expect(check(outcome, "linux-arm64 Claude engine live qualification")).toEqual({
      name: "linux-arm64 Claude engine live qualification", status: "blocked", detail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock; start Docker Desktop",
    });
  });

  test("blocks the Linux live tier with the helper command when the volume holds no login, and with Docker's reason when Docker cannot answer", () => {
    const linuxAbsent = orchestrate("darwin", "arm64", { run: (command) => {
      if (command[0] === "/docker" && isStatusRead(command)) return { exitCode: 0, stdout: "absent\n", stderr: "" };
      if (isStatusRead(command)) return PRESENT;
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } }, { shipped: "0.3.295" });
    expect(linuxAbsent.commands.some(isLinuxLive)).toBe(false);
    expect(linuxAbsent.commands).toContainEqual(LIVE_TIER);
    expect(check(linuxAbsent.outcome, "linux-arm64 Claude engine live qualification")).toEqual({
      name: "linux-arm64 Claude engine live qualification", status: "blocked",
      detail: `${SDK} 0.3.295 in ${RELEASE_TAG} is now 0.3.296; the Docker volume flywheel-readiness-claude holds no Claude login with a stored token in the auth profile "Live": run \`bun run readiness:login linux\``,
    });

    const noDaemon = orchestrate("darwin", "arm64", { run: (command) => {
      if (command[0] === "/docker") return { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" };
      if (isStatusRead(command)) return PRESENT;
      if (command[0] === "git" && command[1] === "show") return { exitCode: 0, stdout: COMMITTED_TOKENIZER, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } }, { shipped: "0.3.295" });
    expect(check(noDaemon.outcome, "linux-arm64 Claude engine live qualification")?.status).toBe("blocked");
    expect(check(noDaemon.outcome, "linux-arm64 Claude engine live qualification")?.detail).toContain("start Docker Desktop");
    expect(noDaemon.commands.some(isLinuxLive)).toBe(false);
  });

  test("owes no live tier and reads no login when the last release shipped the pinned SDK", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64");
    expect(commands.some(isStatusRead)).toBe(false);
    expect(commands).not.toContainEqual(LIVE_TIER);
    expect(check(outcome, "Claude engine live qualification")).toEqual({ name: "Claude engine live qualification", status: "skip", detail: `${RELEASE_TAG} already shipped ${SDK} 0.3.296` });
  });
});
