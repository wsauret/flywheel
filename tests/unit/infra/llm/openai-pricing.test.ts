import { afterEach, describe, expect, spyOn, test } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => handler(String(request), init), { preconnect: originalFetch.preconnect });
}

describe("OpenAI Standard pricing", () => {
  test("OpenAI pricing Markdown admits only one strict Standard table", async () => {
    // The snapshot is module-global with no reset, and the provider catalogs read it, so this test refreshes a private instance.
    const pricingUrl = new URL("../../../../src/infra/llm/openai-pricing.ts", import.meta.url);
    const pricing: typeof import("../../../../src/infra/llm/openai-pricing.js") = await import(`${pricingUrl.href}?pricing-test=${crypto.randomUUID()}`);
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    let pricingRequests = 0;
    /** Runs one completed refresh against `response` and returns the rate cards it leaves current. */
    const refreshedFrom = async (response: () => Response | Promise<Response>) => {
      installFetch(() => {
        pricingRequests += 1;
        return response();
      });
      clock += 10_000;
      await pricing.refreshOpenAiStandardPricing();
      return pricing.currentOpenAiStandardPricing();
    };
    const markdownResponse = (body: string) => () => new Response(body, { headers: { "content-type": "text/markdown" } });
    const standardRow = "| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |";
    const markdown = [
      "### Standard pricing data",
      "",
      "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      standardRow,
      "",
      "### Batch pricing data",
      "| gpt-6-sol | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |",
    ].join("\n");
    try {
      expect((await refreshedFrom(markdownResponse(markdown))).get("gpt-6-sol")).toEqual({
        input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10,
        highContext: { threshold: 272_000, input: 4, cacheRead: 0.4, cacheWrite: 5, output: 15 },
      });
      const unlistedCells = markdown.replace(standardRow, [
        standardRow,
        "| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |",
        "| gpt-5.4-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |",
        "| gpt-5.4-mini | $0.75 | $0.075 | - | $4.50 | - | - | - | - |",
      ].join("\n"));
      const parsed = await refreshedFrom(markdownResponse(unlistedCells));
      expect(parsed.get("gpt-5.5")).toEqual({
        input: 5, cacheRead: 0.5, output: 30,
        highContext: { threshold: 272_000, input: 10, cacheRead: 1, output: 45 },
      });
      expect(parsed.get("gpt-5.4-pro")).toEqual({ input: 30, output: 180, highContext: { threshold: 272_000, input: 60, output: 270 } });
      expect(parsed.get("gpt-5.4-mini")).toEqual({ input: 0.75, cacheRead: 0.075, output: 4.5 });

      // A refresh that fails closed admits no rate cards, so the last complete snapshot stays current.
      expect(await refreshedFrom(markdownResponse(markdown.replace("### Standard pricing data", "### Changed")))).toBe(parsed);
      expect(await refreshedFrom(markdownResponse(markdown.replace(standardRow, `${standardRow}\n${standardRow}`)))).toBe(parsed);
      expect(await refreshedFrom(() => Promise.reject(new Error("offline")))).toBe(parsed);
      expect(await refreshedFrom(markdownResponse("x".repeat(512 * 1024 + 1)))).toBe(parsed);
      expect(pricingRequests).toBe(6);
    } finally {
      now.mockRestore();
    }
  });
});
