import { describe, expect, test } from "bun:test";

import { join, resolve } from "node:path";
import { runPackageSmoke, tarExecutable, verifyPackagedTokenizer, verifyStringEditPlanner, type PackageSmokeDependencies } from "../../../scripts/readiness-package-smoke.js";
import { planStringEdit } from "../../../src/infra/file-edit/string-edit.js";

const SMOKE = resolve("/scratch/smoke");
const workspace = {
  root: SMOKE,
  extracted: join(SMOKE, "extracted"),
  home: join(SMOKE, "home"),
  bin: join(SMOKE, "bin"),
  project: join(SMOKE, "project"),
};

function dependencies(results: readonly { exitCode: number; stdout: string; stderr: string }[], calls: string[] = []): PackageSmokeDependencies {
  let index = 0;
  return {
    createWorkspace: () => workspace,
    probeRipgrepAddon: async (path) => { calls.push(`ripgrep:${path}`); return 1; },
    probeTokenizerAsset: async (path) => { calls.push(`tokenizer:${path}`); return "O200kBase,ClaudeV3,ClaudeV47,ClaudeV5,ClaudeV5Sonnet"; },
    probeStringEditPlanner: async () => { calls.push("planners"); return "exact,line-ending,uniform-indent"; },
    run: (command) => { calls.push(command.join(" ")); return results[index++] ?? { exitCode: 0, stdout: "", stderr: "" }; },
    readText: (path) => {
      calls.push(`read:${path}`);
      return JSON.stringify({ version: "0.0.8", buildId: BUILD_ID, asset: "flywheel-linux-x64.tar.gz" });
    },
    cleanup: () => undefined,
    findPowerShell: () => "powershell",
    environment: {},
  };
}

const success = { exitCode: 0, stdout: "", stderr: "" };
const BUILD_ID = "d".repeat(64);

describe("readiness package smoke", () => {
  test("propagates a packaged version mismatch", async () => {
    const deps = dependencies([success, success, { exitCode: 0, stdout: "flywheel 9.9.9", stderr: "" }]);
    await expect(runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps)).rejects.toThrow('installed version was "flywheel 9.9.9"');
  });

  test("requires the installed build to name the build identity its archive states", async () => {
    const deps = dependencies([success, success, { exitCode: 0, stdout: "flywheel 0.0.8", stderr: "" }]);
    await expect(runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps)).rejects.toThrow(`not "flywheel 0.0.8 (build ${BUILD_ID})"`);
  });

  test("propagates a failed required subprocess", async () => {
    const deps = dependencies([{ exitCode: 2, stdout: "", stderr: "corrupt archive" }]);
    await expect(runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps)).rejects.toThrow("archive extraction exited 2: corrupt archive");
  });

  test("defines exact, CRLF, and tab-indentation planner probes that the TypeScript planner passes", () => {
    const calls: Array<{ source: string; oldString: string; newString: string }> = [];
    const summary = verifyStringEditPlanner((source, edit) => {
      calls.push({ source, oldString: edit.oldString, newString: edit.newString });
      return planStringEdit(source, edit);
    });

    expect(calls).toEqual([
      { source: "one two", oldString: "two", newString: "three" },
      { source: "one\r\ntwo\r\n", oldString: "one\ntwo\n", newString: "uno\ndos\n" },
      { source: "fn main() {\n\tone\n\ttwo\n}\n", oldString: "one\ntwo", newString: "uno\ndos" },
    ]);
    expect(summary).toBe("exact,line-ending,uniform-indent");
    expect(() => verifyStringEditPlanner(() => ({ content: "wrong", matchKind: "exact" }))).toThrow("string edit planner failed exact probe");
  });

  test("runs the planner probe on its own", async () => {
    const calls: string[] = [];
    await runPackageSmoke({ target: "darwin-arm64", planners: true }, dependencies([], calls));
    expect(calls).toEqual(["planners"]);
  });

  test("probes a staged ripgrep addon", async () => {
    const calls: string[] = [];
    const addon = resolve("/dist/native/flywheel-ripgrep.win32-x64.node");
    await runPackageSmoke({ target: "win32-x64", addon }, dependencies([], calls));
    expect(calls).toEqual([`ripgrep:${addon}`]);
  });

  test("probes the packaged ripgrep addon and the installed commands from an archive", async () => {
    const calls: string[] = [];
    const deps = dependencies([
      success,
      success,
      { exitCode: 0, stdout: `flywheel 0.0.8 (build ${BUILD_ID})`, stderr: "" },
      success,
      { exitCode: 1, stdout: "", stderr: join(workspace.project, ".flywheel", "flywheel.sqlite") },
    ], calls);

    await runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps);

    expect(calls).toEqual([
      `${tarExecutable()} -xzf ${resolve("/archive.tar.gz")} -C ${workspace.extracted}`,
      `ripgrep:${join(workspace.extracted, "flywheel-linux-x64", "build", "native", "linux-x64", "flywheel-ripgrep.linux-x64.node")}`,
      `tokenizer:${join(workspace.extracted, "flywheel-linux-x64", "build", "native", "linux-x64", "flywheel-tokenizer.wasm.zst")}`,
      `sh ${join(workspace.extracted, "flywheel-linux-x64", "install.sh")}`,
      `read:${join(workspace.extracted, "flywheel-linux-x64", "build", "build.json")}`,
      `${join(workspace.bin, "flywheel")} --version`,
      `${join(workspace.bin, "flywheel")} auth status`,
      `${join(workspace.bin, "flywheel")} --project-root ${workspace.project} events search --list-types`,
    ]);
  });

  test("verifies the tracked tokenizer digest, strict ABI, and fixtures without a target binary", async () => {
    const root = resolve(import.meta.dir, "../../..");
    await expect(verifyPackagedTokenizer(
      join(root, "crates", "tokenizer", "flywheel-tokenizer.wasm.zst"),
      join(root, "crates", "tokenizer", "tokenizer-prebuilt.json"),
    )).resolves.toBe("O200kBase,ClaudeV3,ClaudeV47,ClaudeV5,ClaudeV5Sonnet");
  });
});
