import { expect, test } from "bun:test";
import { campaignToolExclusionEvidence } from "../../../bench/chat-ab/campaign-tool-evidence.js";
import { providerRequestFacts } from "../orchestration/session/_provider-request-audit-fixtures.js";
import type { ExecutionEvidence } from "../../../src/protocol/session/execution-evidence.js";

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

async function audit(registrationId: string): Promise<string> {
  const facts = await providerRequestFacts({
    requestId: "request", identity: { providerSessionKey: "root", conversationId: "root" }, turn: 1,
    promptKind: "chat", systemPrompt: "test", messages: [], messageCount: 0, estimatedContextTokens: 0, attemptStaticTokens: 0, contextWindow: 100,
    tools: [{ name: registrationId, registrationId, executableId: registrationId, description: "", input_schema: { type: "object" } }],
    omittedTools: [], interactionProfileId: "default", model: "test-model", accessProvider: "anthropic", modelFamily: "anthropic",
  }, {});
  return facts.map((fact, index) => JSON.stringify({
    source: "store", ...fact, id: `fact-${index}`, aggregateId: "session:root", position: index + 1, seq: index + 1, timestamp: 0, sessionId: "root",
  })).join("\n");
}

test("checks every offered registration against its canonical tool owner", async () => {
  expect(campaignToolExclusionEvidence(await audit("bash"), evidence, ["bash"])).toMatchObject({
    requests: [{ sessionId: "root", requestId: "request", tools: ["bash"] }],
    violations: [{ sessionId: "root", requestId: "request", tool: "bash" }],
  });
  expect(campaignToolExclusionEvidence(await audit("read"), evidence, ["bash"]).violations).toEqual([]);
  expect(campaignToolExclusionEvidence(await audit("benchmark"), evidence, ["subagent"]).violations).toEqual([]);
});

test("refuses exclusion proof when an offered registration cannot be resolved", async () => {
  const unknown = await audit("unknown-registration");
  expect(() => campaignToolExclusionEvidence(unknown, evidence, ["bash"])).toThrow("Tool registration evidence is unavailable");
});
