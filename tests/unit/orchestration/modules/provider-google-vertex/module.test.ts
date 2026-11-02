import { afterEach, expect, test } from "bun:test";
import { Redacted } from "effect";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { googleVertexModule } from "../../../../../src/orchestration/modules/provider-google-vertex/module.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => handler(String(request), init), { preconnect: originalFetch.preconnect });
}

test("Vertex checks access with countTokens and treats only 404 as a refusal", async () => {
  const provider = googleVertexModule.contributions.find((contribution) => contribution.domain === "providers");
  const probe = provider?.domain === "providers" ? provider.value.definition.dynamicCatalog.probeAccess : undefined;
  if (probe === undefined) throw new Error("Vertex declares no access probe");
  const check = (signal: AbortSignal = AbortSignal.timeout(1_000)) => probe({
    credential: { type: "api_key", key: Redacted.make("secret") },
    authDir: "/unused",
    classifySlot: credentialSlotClassifier(composeFirstPartyModules()),
    oauthPersistence: "profile",
    signal,
    wireModelId: "gemini-flash-latest",
  });
  let status = 200;
  installFetch((url, init) => {
    expect(url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-flash-latest:countTokens");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret");
    expect(JSON.parse(String(init?.body))).toEqual({ contents: [{ role: "user", parts: [{ text: "OK" }] }] });
    return Response.json({ totalTokens: 1 }, { status });
  });
  for (const [code, outcome] of [[200, "completed"], [404, "refused"], [400, "inconclusive"], [401, "inconclusive"], [429, "inconclusive"], [500, "inconclusive"]] as const) {
    status = code;
    expect(await check()).toBe(outcome);
  }
  installFetch(() => { throw new TypeError("network failed"); });
  expect(await check()).toBe("inconclusive");
  await expect(check(AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
});
