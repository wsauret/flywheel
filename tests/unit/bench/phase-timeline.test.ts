import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeCodePhases, flywheelPhases } from "../../../bench/chat-ab/phase-timeline.js";
import type { ExecutionEvidence } from "../../../src/protocol/execution-evidence.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();

type Session = ExecutionEvidence["sessions"][number];
const request = (attemptId: string, at: number, conversationId?: string, workflowAttemptId?: string): Session["requests"][number] => ({
  requestId: attemptId, attemptId, identity: { providerSessionKey: conversationId ?? "background", ...(conversationId ? { conversationId } : {}) },
  turn: 1, preparedAt: at, respondedAt: at + 1000, dispatchState: "dispatched", completionState: "terminal", purpose: "normal",
  model: "claude-sonnet-5.5", measurement: "available", ...(workflowAttemptId ? { workflowAttemptId } : {}),
});
const usage = (attemptId: string, usd: number): Session["usageEntries"][number] => ({
  attemptId, occurredAt: "2026-10-13T00:00:00.000Z", profileId: "Personal", attribution: { kind: "candidate", providerId: "anthropic", instanceId: "account" },
  spendMode: "included", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "claude-sonnet-5.5",
  tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "subscription_equivalent",
  price: { kind: "priced", estimatedUsd: usd, rateCard: {}, provenance: "fixture" }, currency: "USD", coverage: "complete",
});

test("splits Flywheel chat around its workflow and names each agent by its attempt id", () => {
  const evidence: ExecutionEvidence = {
    version: 2, projectRoot: "/scratch", rootSessionId: "chat", descendantDiscovery: "current-metadata", metadataGaps: [],
    accounting: { usage: "available", price: "estimate", providerInvoicedCost: "unavailable" },
    sessions: [
      { sessionId: "chat", kind: "chat", requests: [request("c1", 0, "chat"), request("c2", 30_000, "chat")], usageEntries: [usage("c1", 0.5), usage("c2", 0.1)] },
      { sessionId: "workflow", kind: "workflow-agent", parentSessionId: "chat", requests: [request("s1", 5_000, "agent-1", "implement"), request("s2", 10_000, "agent-1"), request("b1", 12_000)], usageEntries: [usage("s1", 0.2), usage("s2", 0.2)] },
      { sessionId: "subagent", kind: "subagent", parentSessionId: "workflow", requests: [request("nested", 7000, "subagent")], usageEntries: [usage("nested", 0.1)] },
    ],
  };
  const phases = flywheelPhases(evidence);
  expect(phases.map(({ label, kind, startMs, endMs, requests, unpriced }) => ({ label, kind, startMs, endMs, requests, unpriced }))).toEqual([
    { label: "chat before launch", kind: "chat", startMs: 0, endMs: 1000, requests: 1, unpriced: 0 },
    { label: "attempt implement", kind: "workflow-agent", startMs: 5000, endMs: 11_000, requests: 2, unpriced: 0 },
    { label: "agent 1", kind: "subagent", startMs: 7000, endMs: 8000, requests: 1, unpriced: 0 },
    { label: "other requests (claude-sonnet-5.5)", kind: "background", startMs: 12_000, endMs: 13_000, requests: 1, unpriced: 1 },
    { label: "chat after completion", kind: "chat", startMs: 30_000, endMs: 31_000, requests: 1, unpriced: 0 },
  ]);
  expect(phases[1]?.usd).toBeCloseTo(0.4);
});

test("reads Claude Code agents from the transcript tree and shares the list cost by token weight", async () => {
  const run = temporary("phase-claude-");
  const transcripts = join(run, "transcripts");
  const agents = join(transcripts, "session", "subagents", "workflows", "wf_one");
  await mkdir(agents, { recursive: true });
  const line = (id: string, at: string, output: number) => JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: output } } });
  await writeFile(join(transcripts, "session.jsonl"), [line("m1", "2026-10-13T00:00:00.000Z", 100), line("m1", "2026-10-13T00:00:02.000Z", 100), line("m2", "2026-10-13T00:00:20.000Z", 100)].join("\n"));
  await writeFile(join(agents, "agent-a.jsonl"), line("a1", "2026-10-13T00:00:05.000Z", 200));
  await writeFile(join(agents, "agent-a.meta.json"), JSON.stringify({ description: "implement" }));
  await writeFile(join(agents, "agent-c.jsonl"), line("c1", "2026-10-13T00:00:06.000Z", 0));
  await writeFile(join(agents, "agent-c.meta.json"), JSON.stringify({ description: "implement" }));
  await writeFile(join(transcripts, "session", "subagents", "agent-b.jsonl"), line("b1", "2026-10-13T00:00:07.000Z", 0));
  await writeFile(join(transcripts, "session", "subagents", "agent-b.meta.json"), JSON.stringify({ description: "implement" }));
  await writeFile(join(run, "stream.jsonl"), JSON.stringify({ type: "result", total_cost_usd: 0.4 }));
  const phases = await claudeCodePhases(run);
  expect(phases.map(({ label, kind, startMs, endMs, requests }) => ({ label, kind, startMs, endMs, requests }))).toEqual([
    { label: "chat before launch", kind: "chat", startMs: 0, endMs: 2000, requests: 1 },
    { label: "implement", kind: "workflow-agent", startMs: 5000, endMs: 5000, requests: 1 },
    { label: "implement", kind: "workflow-agent", startMs: 6000, endMs: 6000, requests: 1 },
    { label: "implement", kind: "subagent", startMs: 7000, endMs: 7000, requests: 1 },
    { label: "chat after completion", kind: "chat", startMs: 20_000, endMs: 20_000, requests: 1 },
  ]);
  expect(phases[1]?.usd).toBeCloseTo(0.2);
});
