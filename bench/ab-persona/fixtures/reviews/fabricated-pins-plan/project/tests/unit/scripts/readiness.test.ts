import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { RELEASE_ARCHIVES, RELEASE_BUILD_COMMANDS, RELEASE_TARGETS } from "../../../scripts/release-contract.js";
import { dockerRuntimeCommand, readinessPlan } from "../../../scripts/readiness-plan.js";
import { runReadiness, type ReadinessDependencies } from "../../../scripts/readiness.js";

const ROOT = "/repo";
const BUN = "/bun";
const HARNESS = join(ROOT, "scripts", "readiness-package-smoke.ts");

function orchestrate(platform: string, arch: string, overrides: Partial<ReadinessDependencies> = {}) {
  const commands: string[][] = [];
  const dependencies: ReadinessDependencies = {
    exists: () => true,
    which: (name) => name === "docker" ? "/docker" : undefined,
    run: (command) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: command[0] === "/docker" && command[1] === "info" ? "Server Version: 27" : "", stderr: "" };
    },
    log: () => undefined,
    ...overrides,
  };
  const outcome = runReadiness({ root: ROOT, platform, arch, quick: false, bunExecutable: BUN, bunVersion: "1.3.14", version: "0.0.8" }, dependencies);
  return { commands, outcome };
}

describe("deployment readiness planning", () => {
  test("derives macOS builds and Linux evidence from the canonical matrix", () => {
    const plan = readinessPlan("darwin", "arm64", false);
    expect(plan.builds.map((build) => build.target)).toEqual(RELEASE_TARGETS);
    expect(plan.builds.map((build) => build.archive)).toEqual(RELEASE_ARCHIVES);
    expect(plan.builds.map((build) => build.command)).toEqual(RELEASE_BUILD_COMMANDS);
    expect(plan.linuxRuntime.map(({ target, evidence }) => ({ target, evidence }))).toEqual([
      { target: "linux-arm64", evidence: "native container functional evidence" },
      { target: "linux-x64", evidence: "emulated container functional evidence" },
    ]);
  });

  test("constructs Docker runtime commands with the exact host Bun version", () => {
    expect(dockerRuntimeCommand({ target: "linux-x64", dockerPlatform: "linux/amd64", archive: join(ROOT, "dist", "flywheel-linux-x64.tar.gz"), harness: HARNESS, version: "0.0.8", bunVersion: "1.3.14" })).toEqual([
      "docker", "run", "--rm", "--platform=linux/amd64", "--network=none",
      "--mount", `type=bind,source=${join(ROOT, "dist", "flywheel-linux-x64.tar.gz")},target=/input/archive.tar.gz,readonly`,
      "--mount", `type=bind,source=${HARNESS},target=/input/readiness-package-smoke.ts,readonly`,
      "oven/bun:1.3.14", "bun", "run", "/input/readiness-package-smoke.ts",
      "--archive", "/input/archive.tar.gz", "--target", "linux-x64", "--expected-version", "0.0.8",
    ]);
  });
});

describe("readiness orchestration", () => {
  test("runs complete macOS arm64 readiness in exact order without mutation or publication", () => {
    const { commands, outcome } = orchestrate("darwin", "arm64");
    const archives = RELEASE_ARCHIVES.map((archive) => join(ROOT, "dist", archive));
    expect(commands).toEqual([
      ["git", "status", "--porcelain=v1", "--untracked-files=all"],
      [BUN, "run", "check:commits", "--upstream", "--head", "HEAD"],
      [BUN, "install", "--frozen-lockfile", "--dry-run"], [BUN, "run", "lint"], [BUN, "run", "check:boundaries"], [BUN, "run", "test"], [BUN, "run", "test:integration"],
      ...RELEASE_BUILD_COMMANDS.map((command) => [BUN, ...command.slice(1)]),
      [BUN, "run", HARNESS, "--addon", join(ROOT, "dist", "flywheel-darwin-arm64", "build", "native", "darwin-arm64", "flywheel-ripgrep.darwin-arm64.node"), "--target", "darwin-arm64"],
      [BUN, "run", "scripts/verify-production-composition.ts", "--binary", join(ROOT, "dist", "flywheel-darwin-arm64", "build", "flywheel-bin")],
      [BUN, "run", "test:perf", "--archive", archives[0]!],
      [BUN, "run", HARNESS, "--archive", archives[0]!, "--target", "darwin-arm64", "--expected-version", "0.0.8"], ["/docker", "info"],
      dockerRuntimeCommand({ target: "linux-arm64", dockerPlatform: "linux/arm64", archive: archives[1]!, harness: HARNESS, version: "0.0.8", bunVersion: "1.3.14" }).map((part, index) => index === 0 ? "/docker" : part),
      dockerRuntimeCommand({ target: "linux-x64", dockerPlatform: "linux/amd64", archive: archives[2]!, harness: HARNESS, version: "0.0.8", bunVersion: "1.3.14" }).map((part, index) => index === 0 ? "/docker" : part),
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(commands.flat().join(" ")).not.toMatch(/release|publish|push|tag|models:snapshot|install:local/);
  });

  test("runs complete Windows host-capable readiness in exact order", () => {
    const { commands, outcome } = orchestrate("win32", "x64");
    expect(commands).toEqual([
      ["git", "status", "--porcelain=v1", "--untracked-files=all"], [BUN, "run", "check:commits", "--upstream", "--head", "HEAD"],
      [BUN, "install", "--frozen-lockfile", "--dry-run"], [BUN, "run", "lint"], [BUN, "run", "check:boundaries"], [BUN, "run", "test"], [BUN, "run", "test:integration"],
      [BUN, "run", "scripts/build-binary.ts", "--target=bun-windows-x64", "--native-provenance=source-build"],
      [BUN, "run", HARNESS, "--addon", join(ROOT, "dist", "flywheel-win32-x64", "native", "win32-x64", "flywheel-ripgrep.win32-x64.node"), "--target", "win32-x64"],
      [BUN, "run", "scripts/verify-production-composition.ts", "--binary", join(ROOT, "dist", "flywheel-win32-x64", "flywheel.exe")],
      [BUN, "run", HARNESS, "--archive", join(ROOT, "dist", "flywheel-win32-x64.tar.gz"), "--target", "win32-x64", "--expected-version", "0.0.8"],
    ]);
    expect(outcome.exitCode).toBe(0);
  });

  test("fails dirty trees and failed required checks", () => {
    expect(orchestrate("win32", "x64", { run: (command) => ({ exitCode: 0, stdout: command[0] === "git" ? "?? new-file" : "", stderr: "" }) }).outcome.exitCode).toBe(1);
    expect(orchestrate("win32", "x64", { run: (command) => ({ exitCode: command.includes("check:commits") ? 2 : 0, stdout: "", stderr: "bad commit" }) }).outcome.exitCode).toBe(1);
  });

  test("blocks Docker checks with diagnostic-specific guidance", () => {
    const socket = orchestrate("darwin", "arm64", { run: (command) => command[1] === "info" ? { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" } : { exitCode: 0, stdout: "", stderr: "" } });
    expect(socket.outcome.exitCode).toBe(1);
    expect(socket.outcome.checks.at(-2)?.detail).toContain("start Docker Desktop");
    const permission = orchestrate("darwin", "arm64", { run: (command) => command[1] === "info" ? { exitCode: 1, stdout: "", stderr: "permission denied while trying to connect" } : { exitCode: 0, stdout: "", stderr: "" } });
    expect(permission.outcome.checks.at(-2)?.detail).toContain("permission denied while trying to connect");
    expect(permission.outcome.checks.at(-2)?.detail).not.toContain("start Docker Desktop");
  });
});
