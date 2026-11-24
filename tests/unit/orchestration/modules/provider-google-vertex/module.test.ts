import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redacted } from "effect";
import type { RuntimeApiKeyCredential } from "../../../../../src/infra/auth/auth-context.js";
import { loadAuthStoreWithDiagnostics } from "../../../../../src/infra/auth/store/auth-store.js";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { googleVertexModule } from "../../../../../src/orchestration/modules/provider-google-vertex/module.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { fakeAvailability } from "../../agent-runtime/llm/_provider-chain-harness.js";

const originalFetch = globalThis.fetch;
const temporaryDirectory = temporaryDirectories();
const classifySlot = credentialSlotClassifier(composeFirstPartyModules());
const PROJECT = "412275039031";
const DISCOVERY_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/flywheel-project-discovery:countTokens";
const GLOBAL_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-4-neon:countTokens`;
const NOT_FOUND = { error: { code: 404, status: "NOT_FOUND", message: `Publisher model \`projects/${PROJECT}/locations/us-central1/publishers/google/models/flywheel-project-discovery\` was not found or your project does not have access to it. Ensure you are using a valid model name and that the model is available in the specified region.` } };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => {
    urls.push(String(request));
    return handler(String(request), init);
  }, { preconnect: originalFetch.preconnect });
  return urls;
}

function vertexDefinition() {
  const provider = googleVertexModule.contributions.find((contribution) => contribution.domain === "providers");
  if (provider?.domain !== "providers") throw new Error("Vertex declares no provider");
  return provider.value.definition;
}

function probe(credential: RuntimeApiKeyCredential, account: { readonly authDir?: string; readonly lineage?: string } = {}, signal: AbortSignal = AbortSignal.timeout(1_000)) {
  return vertexDefinition().dynamicCatalog.probeAccess({
    credential,
    authDir: account.authDir ?? "/unused",
    ...(account.lineage === undefined ? {} : { lineage: account.lineage }),
    classifySlot,
    oauthPersistence: "profile",
    signal,
    wireModelId: "gemini-4-neon",
  });
}

test("Vertex checks access with countTokens in the key's global project and treats only 404 as a refusal", async () => {
  const check = (signal?: AbortSignal) => probe({ type: "api_key", key: Redacted.make("secret"), project: PROJECT }, {}, signal);
  let status = 200;
  installFetch((url, init) => {
    expect(url).toBe(GLOBAL_URL);
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

test("Vertex finds an added key's project in the not-found reply to a model that does not exist", async () => {
  const discover = vertexDefinition().auth.discoverProject;
  const urls = installFetch(() => Response.json(NOT_FOUND, { status: 404 }));
  expect(await discover(Redacted.make("secret"))).toBe(PROJECT);
  expect(urls).toEqual([DISCOVERY_URL]);

  installFetch(() => Response.json({ error: { code: 401, message: "API key not valid. Please pass a valid API key." } }, { status: 401 }));
  await expect(discover(Redacted.make("bad"))).rejects.toThrow("Google Vertex rejected this API key");

  for (const [status, body] of [[404, { error: { code: 404, message: "Not found" } }], [403, { error: { code: 403, message: `projects/${PROJECT}/locations/global denied` } }]] as const) {
    installFetch(() => Response.json(body, { status }));
    await expect(discover(Redacted.make("secret"))).rejects.toThrow(`Google Vertex did not name the key's project (HTTP ${status})`);
  }

  installFetch(() => { throw new TypeError("network failed"); });
  await expect(discover(Redacted.make("secret"))).rejects.toThrow("Could not reach Google Vertex to find the key's project: network failed");
});

// The record shape that every Vertex key saved before 2026-11-19 has: no project beside the key.
test("a saved Vertex key without a project gains it on first use under the same lineage", async () => {
  const authDir = join(temporaryDirectory("flywheel-test-vertex-"), ".flywheel", "auth");
  mkdirSync(authDir, { recursive: true });
  const lineageId = crypto.randomUUID();
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ google_vertex: { type: "api_key", key: "AQ.saved", lineageId } }), { mode: 0o600 });
  expect(loadAuthStoreWithDiagnostics(authDir, undefined, classifySlot, false).store.google_vertex).toEqual({ type: "api_key", key: "AQ.saved" });

  const urls = installFetch((url) => url === DISCOVERY_URL ? Response.json(NOT_FOUND, { status: 404 }) : Response.json({ totalTokens: 1 }));
  const credential: RuntimeApiKeyCredential = { type: "api_key", key: Redacted.make("AQ.saved") };
  expect(await probe(credential, { authDir, lineage: lineageId })).toBe("completed");
  // The next probe of the same audit pass carries the same captured credential and reuses the found project.
  expect(await probe(credential, { authDir, lineage: lineageId })).toBe("completed");

  expect(urls).toEqual([DISCOVERY_URL, GLOBAL_URL, GLOBAL_URL]);
  expect(JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8"))).toEqual({ google_vertex: { type: "api_key", key: "AQ.saved", project: PROJECT, lineageId } });
});

test("a caller that stops while a shared discovery runs does not fail the other callers that wait for it", async () => {
  const authDir = join(temporaryDirectory("flywheel-test-vertex-"), ".flywheel", "auth");
  mkdirSync(authDir, { recursive: true });
  const lineageId = crypto.randomUUID();
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ google_vertex: { type: "api_key", key: "AQ.saved", lineageId } }), { mode: 0o600 });
  const reply = Promise.withResolvers<void>();
  globalThis.fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => {
    if (String(request) !== DISCOVERY_URL) return Response.json({ totalTokens: 1 });
    // The discovery request ends when its own signal aborts, as a real fetch does.
    await Promise.race([reply.promise, new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))]);
    return Response.json(NOT_FOUND, { status: 404 });
  }, { preconnect: originalFetch.preconnect });
  const credential: RuntimeApiKeyCredential = { type: "api_key", key: Redacted.make("AQ.saved") };
  const first = new AbortController();
  const stopped = probe(credential, { authDir, lineage: lineageId }, first.signal);
  const joined = probe(credential, { authDir, lineage: lineageId });
  first.abort(new Error("superseded"));
  reply.resolve();
  await expect(stopped).rejects.toThrow("superseded");
  expect(await joined).toBe("completed");
});

function clientBuild(authDir: string, lineageId: string): AccessProviderBuild {
  const candidate = { kind: "singleton", providerId: "google_vertex", spendMode: "direct_api" } as const;
  const metadata = providerModelInfo({ provider: "google", id: "gemini-4-neon", contextLimit: 1_000_000, outputLimit: 64_000 });
  return {
    notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
    candidate, providerIdentity: { name: "Google Vertex", credential: "api_key" },
    model: metadata.id, wireModelId: metadata.id, family: "google",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir, oauthPersistence: "profile",
      auth: { providers: new Map([["google_vertex", { kind: "api_key", key: Redacted.make("AQ.saved") }]]), credentialLineages: { google_vertex: lineageId }, droppedCredentials: [] },
      subscriptionCredentials: new Map(),
    },
    classifySlot, availability: fakeAvailability({}).availability, projectRoot: "/scratch",
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: () => {},
  };
}

async function connectClient(build: AccessProviderBuild) {
  const provider = googleVertexModule.contributions.find((contribution) => contribution.domain === "providers");
  if (provider?.domain !== "providers") throw new Error("Vertex declares no provider");
  const adapter = await provider.value.createClient(build);
  return (await adapter.stage({ attribution: build.attribution, accountOfferings: [] })).connect();
}

// The record shape that every Vertex key saved before 2026-11-19 has: no project beside the key.
test("the Vertex client of a key saved without a project sends requests to the found project in the global location", async () => {
  const authDir = join(temporaryDirectory("flywheel-test-vertex-"), ".flywheel", "auth");
  mkdirSync(authDir, { recursive: true });
  const lineageId = crypto.randomUUID();
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ google_vertex: { type: "api_key", key: "AQ.saved", lineageId } }), { mode: 0o600 });
  const urls = installFetch((url) => url === DISCOVERY_URL
    ? Response.json(NOT_FOUND, { status: 404 })
    : Response.json({ error: { code: 400, message: "recorded", status: "INVALID_ARGUMENT" } }, { status: 400 }));

  const client = await connectClient(clientBuild(authDir, lineageId));
  try {
    for await (const _event of client.streamWithTools({ messages: [{ kind: "user", origin: "human", content: "Hi." }], tools: [], systemPrompt: { stable: "", session: "", conversation: "" } })) { /* The recorded refusal ends the stream. */ }
  } catch { /* The recorded refusal fails the request after it was sent. */ }

  expect(urls).toEqual([DISCOVERY_URL, `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/global/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse`]);
  expect(JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8"))).toEqual({ google_vertex: { type: "api_key", key: "AQ.saved", project: PROJECT, lineageId } });
});

test("the Vertex client stops on a rejected key and retries or fails over when discovery fails for a moment", async () => {
  const authDir = join(temporaryDirectory("flywheel-test-vertex-"), ".flywheel", "auth");
  mkdirSync(authDir, { recursive: true });
  const cases = [
    { status: 401, expected: { _tag: "ApiError", recovery: { kind: "none" } } },
    { status: 404, expected: { _tag: "ApiError", recovery: { kind: "none" } } },
    { status: 429, expected: { failure: { _tag: "RateLimitFailure" } } },
    { status: 503, expected: { failure: { _tag: "TransientNetworkFailure" } } },
  ] as const;
  for (const { status, expected } of cases) {
    installFetch(() => Response.json({ error: { code: status, message: "Not available" } }, { status }));
    const error = await connectClient(clientBuild(authDir, crypto.randomUUID())).catch((caught: unknown) => caught);
    if (status >= 429) expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject(expected);
  }
  installFetch(() => { throw Object.assign(new TypeError("socket closed"), { code: "ECONNCLOSED" }); });
  const lost = await connectClient(clientBuild(authDir, crypto.randomUUID())).catch((caught: unknown) => caught);
  expect(lost).toBeInstanceOf(ProviderAttemptFailure);
  expect(lost).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
});
