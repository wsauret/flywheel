import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { versionsDir } from "../../../src/infra/paths.js";
import { buildExecutable } from "../../../src/infra/update/build-identity.js";
import { collectBuildTrees } from "../../../src/infra/update/build-retention.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { activatePlacedBuild } from "../../helpers/placed-build.js";

const temporary = temporaryDirectories();

test("one sweep removes at most 256 builds, which is what one lease term safely allows, and says it left the rest", async () => {
  const userDataRoot = temporary("flywheel-build-retention-limit-");
  function build(version: string, buildId: string, age: number): string {
    const directory = path.join(versionsDir(userDataRoot), version, buildId);
    fs.mkdirSync(path.join(directory, "native"), { recursive: true });
    fs.writeFileSync(path.join(directory, "native", "libthing.so"), "payload");
    fs.writeFileSync(path.join(directory, buildExecutable(process.platform)), "#!/bin/sh\n", { mode: 0o755 });
    const metadata = path.join(directory, "build.json");
    fs.writeFileSync(metadata, JSON.stringify({ version, buildId, asset: "flywheel-darwin-arm64.tar.gz" }));
    const stamp = new Date(2_000_000_000_000 - age * 60_000);
    fs.utimesSync(metadata, stamp, stamp);
    return buildId;
  }
  const active = build("1.5.0", "a".repeat(64), 0);
  activatePlacedBuild(userDataRoot, { version: "1.5.0", buildId: active });
  build("0.9.0", "8".repeat(64), 1);
  build("0.9.1", "9".repeat(64), 2);
  for (let index = 0; index < 258; index += 1) build("0.1.0", index.toString(16).padStart(64, "0"), 1_000 + index);

  const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

  expect(collected.removedBuilds).toHaveLength(256);
  expect(collected.truncated).toBe(true);
  // The two oldest are what the bound left for the next run.
  expect(fs.readdirSync(path.join(versionsDir(userDataRoot), "0.1.0")).sort()).toEqual([(256).toString(16).padStart(64, "0"), (257).toString(16).padStart(64, "0")]);
});
