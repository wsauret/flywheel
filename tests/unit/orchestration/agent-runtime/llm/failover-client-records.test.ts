import { describe, expect, spyOn, test } from "bun:test";
import { Log } from "../../../../../src/infra/log.js";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { createRoutingDecisions } from "../../../../../src/orchestration/agent-runtime/llm/failover-client.js";
import type { ProviderAffordabilityCapability } from "../../../../../src/orchestration/agent-runtime/llm/provider-affordability.js";
import {
  chain,
  executeStream,
  fakeAvailability,
  fakeClient,
  preparedRequest,
  singletonCandidate,
  streamOptions,
  textStream,
} from "./_provider-chain-harness.js";

/** One client's chain over two candidates, where the named ones cannot
 *  afford the request. Every request made through `serve` shares `routing`,
 *  as every request of one admitted client does. */
function twoCandidateClient() {
  const routing = createRoutingDecisions();
  const unaffordable = new Set<AccessProviderId>();
  const affordability = (provider: AccessProviderId): ProviderAffordabilityCapability => ({
    evaluate: async () => unaffordable.has(provider) ? { kind: "unaffordable", detail: `${provider} cannot afford this request` } : { kind: "eligible" },
  });
  const serve = async () => (await chain({
    candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
    availability: fakeAvailability({}).availability,
    affordability: new Map([["openai_api", affordability("openai_api")], ["openrouter", affordability("openrouter")]]),
    requestAdmission: { subscriptionSpendAuthorizationFor: () => undefined },
    routing,
    build: async (provider) => {
      const attempt = fakeClient(provider, textStream(provider));
      return { attempt, connect: async () => attempt };
    },
  }).admitRequest()).run({
    prepare: preparedRequest,
    execute: ({ client: adapter }) => executeStream(adapter, streamOptions),
  });
  return { serve, unaffordable };
}

function spyRecords() {
  const log = Log.create({ service: "provider-failover" });
  const info = spyOn(log, "info").mockImplementation(() => {});
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  return {
    info,
    warn,
    restore: () => {
      info.mockRestore();
      warn.mockRestore();
    },
  };
}

describe("provider selection records", () => {
  test("records a reroute once while it holds, and the route again each time it changes", async () => {
    const records = spyRecords();
    const client = twoCandidateClient();
    try {
      client.unaffordable.add("openai_api");
      for (let request = 0; request < 3; request++) await client.serve();
      expect(records.info.mock.calls).toEqual([["provider request rerouted", {
        model: expect.any(String),
        chosen: "openrouter",
        passed: [{ provider: "openai_api", reason: "openai_api cannot afford this request" }],
      }]]);

      client.unaffordable.delete("openai_api");
      await client.serve();
      await client.serve();
      expect(records.info.mock.calls.slice(1)).toEqual([["provider request routing restored", {
        model: expect.any(String),
        chosen: "openai_api",
        previousRequests: 3,
      }]]);
      expect(records.warn).not.toHaveBeenCalled();
    } finally {
      records.restore();
    }
  });

  test("records a refusal once while no candidate can serve", async () => {
    const records = spyRecords();
    const client = twoCandidateClient();
    try {
      client.unaffordable.add("openai_api");
      client.unaffordable.add("openrouter");
      await expect(client.serve()).rejects.toThrow();
      await expect(client.serve()).rejects.toThrow();
      expect(records.warn.mock.calls).toEqual([["provider request refused", {
        model: expect.any(String),
        passed: [
          { provider: "openai_api", reason: "openai_api cannot afford this request" },
          { provider: "openrouter", reason: "openrouter cannot afford this request" },
        ],
      }]]);
      expect(records.info).not.toHaveBeenCalled();
    } finally {
      records.restore();
    }
  });

  test("records nothing at the default level for a request its first candidate serves", async () => {
    const records = spyRecords();
    try {
      const client = chain({
        candidates: [singletonCandidate("openai_api")],
        availability: fakeAvailability({}).availability,
        build: async (provider) => {
          const attempt = fakeClient(provider, textStream(provider));
          return { attempt, connect: async () => attempt };
        },
      });
      await (await client.admitRequest()).run({ prepare: preparedRequest, execute: ({ client: adapter }) => executeStream(adapter, streamOptions) });
      expect(records.info).not.toHaveBeenCalled();
      expect(records.warn).not.toHaveBeenCalled();
    } finally {
      records.restore();
    }
  });
});
