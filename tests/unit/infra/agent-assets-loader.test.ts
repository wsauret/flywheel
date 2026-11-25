import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAssetResolution } from "../../../src/infra/definitions/agent-assets/loader.js";
import { temporaryDirectories } from "../../helpers/directories.js";

describe("whole-file agent asset resolution", () => {
  let tmp: string;
  let project: string;
  let user: string;
  let source: string;
  const temporaryDirectory = temporaryDirectories();

  beforeEach(() => {
    tmp = temporaryDirectory("flywheel-agent-assets-");
    project = join(tmp, "project", ".flywheel");
    user = join(tmp, "user", ".flywheel");
    source = join(tmp, "source");
    for (const dir of [project, user, source]) mkdirSync(dir, { recursive: true });
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
