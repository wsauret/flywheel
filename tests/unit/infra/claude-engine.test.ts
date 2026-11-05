import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildPlatformArch, checkoutClaudeEngine } from "../../../src/infra/native-assets.js";
import { enterSourceSnapshot } from "../../../src/infra/source-snapshot.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { snapshotFixture } from "../../helpers/source-snapshot-fixture.js";

type EngineModule = typeof import("../../../src/infra/claude-engine.js");

const ENGINE_MODULE = "src/infra/claude-engine.ts";
const temporaryDirectory = temporaryDirectories();

function write(root: string, files: ReadonlyMap<string, string>): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

describe("the engine that a dev service starts", () => {
  test("is the one its snapshot pinned, so an install that replaces the checkout's engine leaves the service on its own", async () => {
    const root = temporaryDirectory("flywheel-snapshot-engine-");
    const engine = checkoutClaudeEngine(buildPlatformArch());
    write(join(root, "checkout"), new Map([["package.json", "{}\n"], ["bun.lock", "{}\n"], ["src/cli/index.ts", "export {}\n"], [engine, "engine 2.1.296"]]));
    const entry = await enterSourceSnapshot(realpathSync(join(root, "checkout")));
    if (entry.kind !== "created") throw new Error(`the entry did not create a snapshot: ${entry.kind}`);
    const fixture = snapshotFixture(root, [ENGINE_MODULE], { digest: entry.digest });
    const { enginePath } = await fixture.importFromSnapshot<EngineModule>(ENGINE_MODULE);

    expect(enginePath()).toBe(join(entry.root, engine));
    // A hard link: the snapshot holds no second copy of the engine's bytes.
    expect(statSync(enginePath()).ino).toBe(statSync(join(fixture.checkout, engine)).ino);
    // An install removes the old package's files and places the new ones.
    rmSync(join(fixture.checkout, engine));
    write(fixture.checkout, new Map([[engine, "engine 2.1.300"]]));
    expect(readFileSync(enginePath(), "utf8")).toBe("engine 2.1.296");
  });

  test("is the checkout's own when its snapshot pinned none, because the checkout had no engine then", async () => {
    const fixture = snapshotFixture(temporaryDirectory("flywheel-snapshot-no-engine-"), [ENGINE_MODULE]);
    const engine = checkoutClaudeEngine(buildPlatformArch());
    write(fixture.checkout, new Map([[engine, "engine 2.1.300"]]));
    const { enginePath } = await fixture.importFromSnapshot<EngineModule>(ENGINE_MODULE);

    expect(enginePath()).toBe(join(fixture.checkout, engine));
  });
});
