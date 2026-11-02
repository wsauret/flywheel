import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssetResolution, loadFirstAssetFile } from "../../../src/infra/agent-assets/loader.js";
import { temporaryDirectories } from "../../helpers/directories.js";

describe("whole-file agent asset resolution", () => {
  let tmp: string;
  let project: string;
  let user: string;
  let source: string;
  let roots: string[];
  const temporaryDirectory = temporaryDirectories();

  beforeEach(() => {
    tmp = temporaryDirectory("flywheel-agent-assets-");
    project = join(tmp, "project", ".flywheel");
    user = join(tmp, "user", ".flywheel");
    source = join(tmp, "source");
    for (const dir of [project, user, source]) mkdirSync(dir, { recursive: true });
    roots = [project, user, source];
  });

  it("returns the first root's file when it exists", () => {
    writeFileSync(join(project, "system-prompt.md"), "project prompt");
    writeFileSync(join(user, "system-prompt.md"), "user prompt");
    writeFileSync(join(source, "system-prompt.md"), "source prompt");

    expect(loadFirstAssetFile(roots, "system-prompt.md")).toBe("project prompt");
  });

  it("falls through missing layers to the next root", () => {
    writeFileSync(join(user, "system-prompt.md"), "user prompt");
    writeFileSync(join(source, "system-prompt.md"), "source prompt");

    expect(loadFirstAssetFile(roots, "system-prompt.md")).toBe("user prompt");
  });

  it("falls through an unreadable overlay entry to the next root", () => {
    // A directory in the file's place is the read failure the loader must treat
    // as "no override" rather than as corruption.
    mkdirSync(join(project, "shared-rules.md"));
    writeFileSync(join(user, "shared-rules.md"), "user rules");

    expect(loadFirstAssetFile(roots, "shared-rules.md")).toBe("user rules");
  });

  it("returns empty when no root has the file", () => {
    expect(loadFirstAssetFile(roots, "system-prompt.md")).toBe("");
  });

  it("keeps external content byte-for-byte, including legacy-looking installer fields", () => {
    const stamped = `---\nbase_default_hash: ${"a".repeat(64)}\n---\nproject prompt`;
    writeFileSync(join(project, "system-prompt.md"), stamped);

    const resolution = loadAssetResolution(
      [
        { dir: project, layer: "project" },
        { dir: source, layer: "bundled" },
      ],
      "system-prompt.md",
      "bundled prompt",
    );

    expect(resolution.selected?.value).toBe(stamped);
    expect(resolution.selected?.source.identity).toBe(createHash("sha256").update(stamped).digest("hex"));
  });

});
