import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONTAINMENT_REFUSAL } from "../../../../helpers/containment-refusal.js";
import { POSIX_FILE_MODES } from "../../../../helpers/posix-modes.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFullOutput } from "../../../../../src/orchestration/agent-runtime/tools/output-breadcrumb.js";

describe("saveFullOutput", () => {
  let projectRoot: string;
  let outside: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "flywheel-breadcrumb-"));
    outside = mkdtempSync(join(tmpdir(), "flywheel-breadcrumb-outside-"));
  });

  afterEach(() => {
    chmodSync(projectRoot, 0o700);
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const sessionDir = (sessionId: string): string => join(projectRoot, ".flywheel", "agent-outputs", sessionId);

  test("writes content to a per-session, per-tool, owner-only file", async () => {
    const content = "match-1\nmatch-2\nmatch-3\n";

    const path = await saveFullOutput(content, "search", projectRoot, "session-abc");

    if (path === null) throw new Error("output breadcrumb was not written");
    expect(readFileSync(path, "utf8")).toBe(content);
    if (POSIX_FILE_MODES) expect(statSync(path).mode & 0o777).toBe(0o600);
    const files = readdirSync(sessionDir("session-abc"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^search_.*\.txt$/);
  });

  test("sanitizes tool names that contain unsafe path characters", async () => {
    const path = await saveFullOutput("x", "weird/tool name", projectRoot, "s1");
    expect(path).toMatch(/weird_tool_name_/);
    expect(readdirSync(sessionDir("s1")).length).toBe(1);
  });

  test("redacts secrets before they reach the disk breadcrumb", async () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    const path = await saveFullOutput(`API_KEY=${secret}\ntail`, "bash", projectRoot, "s-secret");
    if (path === null) throw new Error("output breadcrumb was not written");
    expect(readFileSync(path, "utf8")).toBe("API_KEY=[redacted secret]\ntail");
  });

  test.each(["", ".", "..", "a/b", "with\0nul"])("throws for the session id %j, which is not one path component", async (rejected) => {
    await expect(saveFullOutput("x", "search", projectRoot, rejected)).rejects.toThrow("one path component");
    expect(existsSync(join(projectRoot, ".flywheel"))).toBe(false);
  });

  test("throws and writes nothing outside the project when a tree component is a symlink", async () => {
    mkdirSync(join(projectRoot, ".flywheel"));
    symlinkSync(outside, join(projectRoot, ".flywheel", "agent-outputs"));

    await expect(saveFullOutput("x", "search", projectRoot, "s-link")).rejects.toThrow(CONTAINMENT_REFUSAL);
    expect(readdirSync(outside)).toEqual([]);
  });

  // A read-only mode is what makes the root unwritable here, and Windows does
  // not enforce directory modes: the write succeeds there, so this case can only
  // state its premise on POSIX.
  test.skipIf(process.platform === "win32")("returns null when the machine refuses the write", async () => {
    // An unwritable project root is the recoverable class: the tool call still
    // owns its truncated answer, so only the breadcrumb gives way.
    writeFileSync(join(projectRoot, "keep.txt"), "keep");
    chmodSync(projectRoot, 0o500);

    expect(await saveFullOutput("x", "search", projectRoot, "s-full")).toBeNull();
  });
});
