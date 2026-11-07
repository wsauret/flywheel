import { describe, expect, test } from "bun:test";

import { runPackageSmoke, type PackageSmokeDependencies } from "../../../scripts/readiness-package-smoke.js";

function dependencies(results: readonly { exitCode: number; stdout: string; stderr: string }[]): PackageSmokeDependencies {
  let index = 0;
  return {
    createWorkspace: () => ({ root: "/tmp/smoke", extracted: "/tmp/smoke/extracted", home: "/tmp/smoke/home", bin: "/tmp/smoke/bin", project: "/tmp/smoke/project" }),
    probeAddon: async () => 1,
    run: () => results[index++] ?? { exitCode: 0, stdout: "", stderr: "" },
    cleanup: () => undefined,
    findPowerShell: () => "powershell",
    environment: {},
  };
}

const success = { exitCode: 0, stdout: "", stderr: "" };

describe("readiness package smoke", () => {
  test("propagates a packaged version mismatch", async () => {
    const deps = dependencies([success, success, { exitCode: 0, stdout: "flywheel 9.9.9", stderr: "" }]);
    await expect(runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps)).rejects.toThrow('installed version was "flywheel 9.9.9"');
  });

  test("propagates a failed required subprocess", async () => {
    const deps = dependencies([{ exitCode: 2, stdout: "", stderr: "corrupt archive" }]);
    await expect(runPackageSmoke({ target: "linux-x64", archive: "/archive.tar.gz", expectedVersion: "0.0.8" }, deps)).rejects.toThrow("archive extraction exited 2: corrupt archive");
  });
});
