import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateShowThinking } from "../../../../src/orchestration/config/writer.js";

async function preservesUnknownBytes(source: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-writer-strict-"));
  const configPath = join(dir, "flywheel.toml");
  try {
    await writeFile(configPath, source);
    const result = updateShowThinking(false, { configPath, userDataRoot: dir });
    expect(result.ok).toBe(true);
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("show_thinking = false");
    for (const line of source.trim().split("\n")) expect(written).toContain(line);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Unknown keys are tolerated at the load boundary, so a settings write must
// succeed while leaving the unrecognized bytes untouched in the file.
describe("config writer with unrecognized keys", () => {
  test("preserves undeclared root keys", () => preservesUnknownBytes("unknown_root = true\n"));

  test("preserves undeclared nested keys", () => preservesUnknownBytes("[notifications]\ndesktop = true\nunknown_nested = true\n"));
});
