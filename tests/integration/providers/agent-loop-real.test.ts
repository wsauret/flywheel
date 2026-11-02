/**
 * Integration test for the agent loop with real API calls: the full agentic
 * cycle on the live model.
 *
 * Requires the auth profile that FLYWHEEL_LIVE_AUTH_PROFILE names, with an
 * account that can serve the live model; the suite fails, and names what the profile can serve, when
 * none can.
 */
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";
import { runLiveAgentLoop } from "./_live-agent-loop.js";
import { LIVE_MODEL } from "./_live-client.js";

const TIMEOUT = 120_000;
const temporaryDirectory = temporaryDirectories();

describe(`Agent loop with ${LIVE_MODEL} (real API)`, () => {
  it("completes a simple file creation task", async () => {
    const tmpDir = temporaryDirectory("agent-runtime-test-");
    const { result, events } = await runLiveAgentLoop({
      label: "completes a simple file creation task",
      instruction: "Create a file called test.txt containing 'hello from the live model'. Use the bash tool.",
      executionCwd: tmpDir,
      timeoutMs: 90_000,
    });

    expect(result.kind).toBe("completed");

    const filePath = path.join(tmpDir, "test.txt");
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    expect(content).toContain("hello from the live model");

    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use")).toBe(true);
  }, TIMEOUT);
});
