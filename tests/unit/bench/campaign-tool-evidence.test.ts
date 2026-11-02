import { expect, test } from "bun:test";
import { campaignToolExclusionEvidence } from "../../../bench/chat-ab/campaign-tool-evidence.js";
import { buildProviderRequestFacts } from "../../../src/orchestration/session/provider-request-audit-recorder.js";
import type { ExecutionEvidence } from "../../../src/protocol/execution-evidence.js";

const evidence: ExecutionEvidence = {
  version: 2, projectRoot: "/scratch", rootSessionId: "root", descendantDiscovery: "current-metadata", metadataGaps: [],
  sessions: [{
    sessionId: "root", kind: "chat", usageEntries: [],
    requests: [{
      requestId: "request", identity: { providerSessionKey: "root", conversationId: "root" }, turn: 1,
      dispatchState: "dispatched", completionState: "terminal", purpose: "normal", measurement: "available",
    }],
  }],
  accounting: { usage: "available", price: "estimate", providerInvoicedCost: "unavailable" },
};

function audit(registrationId: string): string {
  const { facts } = buildProviderRequestFacts({
    requestId: "request", identity: { providerSessionKey: "root", conversationId: "root" }, turn: 1,
    promptKind: "chat", systemPrompt: "test", messages: [], messageCount: 0, estimatedContextTokens: 0, attemptStaticTokens: 0, contextWindow: 100,
    tools: [{ name: registrationId, registrationId, executableId: registrationId, description: "", input_schema: { type: "object" } }],
    omittedTools: [], interactionProfileId: "default", model: "test-model", accessProvider: "anthropic", modelFamily: "anthropic",
  }, {});
  return facts.map((fact, index) => JSON.stringify({
    source: "store", ...fact, id: `fact-${index}`, aggregateId: "session:root", position: index + 1, seq: index + 1, timestamp: 0, sessionId: "root",
  })).join("\n");
}

test("checks every offered registration against its canonical tool owner", () => {
  expect(campaignToolExclusionEvidence(audit("bash"), evidence, ["bash"])).toMatchObject({
    requests: [{ sessionId: "root", requestId: "request", tools: ["bash"] }],
    violations: [{ sessionId: "root", requestId: "request", tool: "bash" }],
  });
  expect(campaignToolExclusionEvidence(audit("read"), evidence, ["bash"]).violations).toEqual([]);
  expect(campaignToolExclusionEvidence(audit("benchmark"), evidence, ["subagent"]).violations).toEqual([]);
});

test("refuses exclusion proof when an offered registration cannot be resolved", () => {
  expect(() => campaignToolExclusionEvidence(audit("unknown-registration"), evidence, ["bash"])).toThrow("Tool registration evidence is unavailable");
});
