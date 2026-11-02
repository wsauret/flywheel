import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { enableCopilotModels } from "../../../../src/orchestration/modules/provider-github-copilot/oauth.js";

const tokens = {
  githubToken: Redacted.make("github"),
  copilotToken: Redacted.make("copilot"),
  expiresAtMs: Date.now() + 60_000,
};

describe("Copilot OAuth model enablement", () => {
  test("posts policy only for exact ids from a successful account listing", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const request = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      return url.endsWith("/models")
        ? Response.json({ data: [{ id: "Claude.Exact-Wire" }, { id: "gpt.exact-wire" }] })
        : new Response(null, { status: 204 });
    }, { preconnect: fetch.preconnect });

    await enableCopilotModels(tokens, request);

    expect(requests).toEqual([
      { url: "https://api.individual.githubcopilot.com/models", method: "GET" },
      { url: "https://api.individual.githubcopilot.com/models/Claude.Exact-Wire/policy", method: "POST" },
      { url: "https://api.individual.githubcopilot.com/models/gpt.exact-wire/policy", method: "POST" },
    ]);
  });

  test("does not post policy when the listing is empty, malformed, or unavailable", async () => {
    for (const listing of [
      Response.json({ data: [] }),
      Response.json({ data: [{ id: 42 }] }),
      new Response(null, { status: 503 }),
    ]) {
      const methods: string[] = [];
      const request = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return listing;
      }, { preconnect: fetch.preconnect });
      await enableCopilotModels(tokens, request);
      expect(methods).toEqual(["GET"]);
    }
  });
});
