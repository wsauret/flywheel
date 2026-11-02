/**
 * The service's answer to each hosted agent's request, on the real engine and a fake service whose error bodies name
 * their request id as the real service does. Concurrent agents interleave their requests and answers, so each answer
 * must reach its own agent by the keys of the engine's debug output, never by order.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isFailoverFailure, ProviderAttemptFailure, type ProviderFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { createHostRegistry, type HostRegistry } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { agentLoop, hostScript, lastUserTexts, lookupThenAnswer, registryProxy, TREE } from "./_agent-host.js";
import { captureDiagnostics, onFakeHost, removeEngineProbes } from "./_claude-sdk-client.js";
import type { FakeReply, RecordedRequest } from "./_fake-host.js";

const temporary = temporaryDirectories();
removeEngineProbes();
const diagnostics = captureDiagnostics();

let registry: HostRegistry;
afterEach(async () => { await registry.drain(); });
const agentHosts = registryProxy(() => registry);

const MODEL_REFUSED = { type: "not_found_error", message: "model: claude-opus-5-5" } as const;
const briefed = (request: RecordedRequest, brief: string) => lastUserTexts(request).some((text) => text.startsWith(brief));

/** The failure that the provider walk read from a request's error. */
function failureOf(error: Error | undefined): ProviderFailure | undefined {
  return error instanceof ProviderAttemptFailure ? error.failure : undefined;
}

/** Runs two hosted agents of one tree at once, with the briefs "A ..." and "B ...", and returns their results. */
async function twoAgents(reply: (request: RecordedRequest) => FakeReply | undefined) {
  registry = createHostRegistry();
  let outcome: Awaited<ReturnType<ReturnType<typeof agentLoop>["request"]>>[] = [];
  let requests: readonly RecordedRequest[] = [];
  await onFakeHost(temporary, hostScript((request) => reply(request) ?? lookupThenAnswer(request)), async ({ host, stage, projectRoot }) => {
    const agents = await Promise.all(["A find.", "B find."].map(async (brief) => agentLoop(await stage({ sharedHost: TREE }), projectRoot, brief)));
    outcome = await Promise.all(agents.map((agent) => agent.request()));
    requests = host.requests;
  }, { seams: { agentHosts } });
  return { a: outcome[0], b: outcome[1], requests };
}

describe("the service's answer to a hosted agent's request", () => {
  test("two concurrent agents each fail with their own answer: A's model refusal from its first request fails over, B's rate limit keeps its own request id and its 17 s retry delay, and A's non-streaming resend is a hidden request", async () => {
    const bArrived = Promise.withResolvers<void>();
    const aResent = Promise.withResolvers<void>();
    const { a, b, requests } = await twoAgents((request) => {
      if (briefed(request, "A ")) {
        if (request.body["stream"] === false) {
          aResent.resolve();
          return { blocks: [], status: 404, error: { type: "not_found_error", message: "model: resent" } };
        }
        // A's answer waits for B's request, so B's request goes out between A's request and A's answer.
        return { blocks: [], status: 404, error: MODEL_REFUSED, after: bArrived.promise };
      }
      if (!briefed(request, "B ")) return undefined;
      bArrived.resolve();
      // B's answer comes after A's resend went out.
      return { blocks: [], status: 429, headers: { "retry-after": "17" }, error: { type: "rate_limit_error", message: "per-minute limit" }, after: aResent.promise.then(() => Bun.sleep(50)) };
    });

    const refused = failureOf(a?.error);
    // A's failure is its first request's answer, not its resend's ("model: resent").
    expect(refused).toMatchObject({ _tag: "ModelAccessFailure", message: MODEL_REFUSED.message });
    expect(refused !== undefined && isFailoverFailure(refused)).toBe(true);
    const bIndex = requests.findIndex((request) => briefed(request, "B "));
    const limited = failureOf(b?.error);
    expect(limited).toMatchObject({ _tag: "RateLimitFailure", retryAfterMs: 17_000 });
    expect(limited?.message).toContain(`"request_id":"req_fake_${bIndex}"`);
    expect(requests.filter((request) => briefed(request, "A ") && request.body["stream"] === false)).toHaveLength(1);
    expect(diagnostics.payloads("provider.claude_sdk.request.hidden")).toMatchObject([{ tag: "unadmitted", phase: "hosted", announcedBy: "request-block" }]);
    expect(diagnostics.payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  }, 120_000);

  test("two concurrent agents that get the same status with different bodies each read their own body", async () => {
    const bArrived = Promise.withResolvers<void>();
    const { a, b } = await twoAgents((request) => {
      if (briefed(request, "A ")) return { blocks: [], status: 404, error: MODEL_REFUSED, after: bArrived.promise };
      if (!briefed(request, "B ")) return undefined;
      bArrived.resolve();
      return { blocks: [], status: 404, error: { type: "not_found_error", message: "File not found: file_123" } };
    });

    expect(failureOf(a?.error)?._tag).toBe("ModelAccessFailure");
    const other = failureOf(b?.error);
    expect(other?._tag).not.toBe("ModelAccessFailure");
    expect(other?.message).toContain("File not found: file_123");
  }, 120_000);

  test("an SSE error that ends one agent's stream fails that agent as a transient cut, recorded once as unattributed, and the other agent answers", async () => {
    const { a, b } = await twoAgents((request) => briefed(request, "A ") ? { blocks: [{ text: "partial" }], streamError: { type: "overloaded_error", message: "Overloaded" } } : undefined);

    expect(failureOf(a?.error)?._tag).toBe("TransientNetworkFailure");
    expect(b?.error).toBeUndefined();
    expect(diagnostics.payloads("provider.claude_sdk.host.stream_error.unattributed")).toMatchObject([{ cliVersion: expect.any(String) }]);
    expect(diagnostics.payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  }, 120_000);
});
