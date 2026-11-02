/**
 * Integration test for subagent failure summarization with a real call to
 * the live model.
 *
 * Exercises the LLM half of the path the wired failure summarizer invokes
 * in production: a real client behind the summary's one-shot runner, the
 * summary request, and JSON extraction. The cheap-tier model mapping and the deterministic fallback
 * call no model, so their unit tests own them.
 *
 * Requires the auth profile that FLYWHEEL_LIVE_AUTH_PROFILE names, with an
 * account that can serve the live model; the suite fails, and names what the profile can serve, when
 * none can.
 */
import { describe, expect, it } from "bun:test";

import { summarizeSubagentWork } from "../../../src/orchestration/modules/subagents/execution/summarize-work.js";
import type { SubagentToolCallRecord } from "../../../src/orchestration/modules/subagents/execution/work-log.js";
import { LIVE_MODEL, withLiveClient } from "./_live-client.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { checkpointTestPersistences } from "../../helpers/checkpoint-store.js";
import { newTestRunner } from "../../helpers/agent-runner.js";
import { testCapabilityModules, testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";

const makeDirectory = temporaryDirectories();
const persistence = checkpointTestPersistences();

const manufacturedTurnLog: SubagentToolCallRecord[] = [
  {
    toolName: "read",
    input: { path: "src/auth/login.ts" },
    status: "done",
    result: "export async function login(email: string, password: string) { /* 80 lines */ }",
  },
  {
    toolName: "search",
    input: { pattern: "validateToken", path: "src/auth" },
    status: "done",
    result: "src/auth/login.ts:14: const valid = await validateToken(t)\nsrc/auth/session.ts:42: validateToken(s.token)",
  },
  {
    toolName: "edit",
    input: { path: "src/auth/login.ts" },
    status: "done",
    result: "@@ -14 +14 @@\n-  const valid = await validateToken(t)\n+  const valid = await validateToken(t, { strict: true })",
  },
  {
    toolName: "bash",
    input: { command: "bun test tests/auth/" },
    status: "error",
    result: "TypeError: validateToken expected 1 argument, got 2\n  at src/auth/session.ts:42",
  },
];

const TERMINAL_ERROR = "context_overflow: subagent exceeded its 200k input-token budget while iterating on the test failure";

describe(`subagent failure summary with ${LIVE_MODEL} (real API)`, () => {
  it("produces a concrete narrative summary from a manufactured failure", async () => {
    const store = persistence({ kind: "session", sessionId: "integration-child" });
    const summary = await withLiveClient("produces a concrete narrative summary", ({ client }) => summarizeSubagentWork({
      records: manufacturedTurnLog,
      terminalError: TERMINAL_ERROR,
      createRunner: (options) => newTestRunner({ ...options, agentsMd: "", model: client.model }, async () => client),
      runnerOptions: async () => {
        const directory = makeDirectory("subagent-summary-real-");
        return {
          projectRoot: directory, executionCwd: directory, userDataRoot: directory, accountHome: directory,
          moduleSelection: testCapabilityModules, captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
          runtimeSurfaces: {}, memorySnapshot: null,
        };
      },
      child: { sessionId: "integration-child", conversationId: "integration-summary", writer: store.sessionEventWriter, reader: store.sessionEventReader },
    }));

    // The summary should be real prose, not the deterministic fallback header.
    expect(summary).not.toContain("## Work completed before error");
    expect(summary.length).toBeGreaterThan(20);
    expect(summary.length).toBeLessThan(1_000);

    // It should reference concrete artifacts from the work log -- the model
    // is instructed to name files, commands, or patterns. We don't pin
    // exact wording, but at least one of these load-bearing strings should
    // survive the LLM's compression.
    const haystack = summary.toLowerCase();
    const concreteAnchors = ["login.ts", "validatetoken", "bun test", "session.ts", "auth"];
    const matches = concreteAnchors.filter((anchor) => haystack.includes(anchor.toLowerCase()));
    expect(matches.length).toBeGreaterThan(0);
  }, 30_000);
});
