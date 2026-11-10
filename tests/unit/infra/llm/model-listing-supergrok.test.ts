import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { readSavedProviderModels } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js";
import { createModelListingClient, type AccessAuditProgress } from "../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../src/infra/llm/models.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { testCapabilityModules, testProviderSelection } from "../../../helpers/provider-authority.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { AUTH_NONE } from "../../orchestration/config/_model-listing-fixtures.js";
import { combinedModelsDevProviders, modelsDevDocument } from "../../../helpers/model-catalog-fixtures.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());
const account = { kind: "subscription", providerId: "supergrok", instanceId: "primary" } as const;
const lineage = "fda8ad92-5f10-43eb-bbaa-62079998d98f";
const roots: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function model(id: string) {
  return { id, name: id, tool_call: true, cost: { input: 2, output: 6 }, limit: { context: 100_000 }, modalities: { input: ["text"], output: ["text"] } };
}

test("API-key access audits persist exact-lineage results, discover new candidates, and manually retry refusals", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-vertex-listing-"));
  roots.push(root);
  const access = await new AuthProfileStore(root).create("default");
  const vertexAccount = { kind: "singleton", providerId: "google_vertex" } as const;
  const writeAuth = (lineageId: string) => access.writeFile("auth.json", JSON.stringify({
    google_vertex: { type: "api_key", key: "AQ.test", lineageId },
  }));
  writeAuth(lineage);
  const auth = { ...AUTH_NONE, providers: new Map([["google_vertex", { kind: "api_key", key: Redacted.make("AQ.test") } as const]]), credentialLineages: { google_vertex: lineage } };
  const document = modelsDevDocument();
  document["google-vertex"] = { name: "Vertex", npm: "@ai-sdk/google-vertex", models: {
    "gemini-ok": model("gemini-ok"), "gemini-flash-latest": model("gemini-flash-latest"), "gemini-flaky": model("gemini-flaky"),
  } };
  const statuses = new Map([["gemini-ok", 200], ["gemini-flash-latest", 404], ["gemini-flaky", 429]]);
  const probes: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("models.dev")) return Response.json(combinedModelsDevProviders(document));
    const id = url.split("/").at(-1)!.replace(":countTokens", "");
    probes.push(id);
    return Response.json({ totalTokens: 1 }, { status: statuses.get(id) ?? 200 });
  }, { preconnect: originalFetch.preconnect });
  const modelsClient = createModelsClient(join(root, "models.json"));
  await modelsClient.refresh(new AbortController().signal);
  const createClient = () => createModelListingClient({ classifySlot, authDir: access.authDirectory, providers: testProviderSelection(), modelsClient });
  let client = createClient();
  const listed = async (mode: "cached-first" | "refresh" | "audit", recheck = false) =>
    (await client.getModelCatalogs(auth, { mode, ...(recheck ? { recheckAccount: vertexAccount } : {}) })).candidates.get(accessProviderAccountKey(vertexAccount));
  expect((await listed("cached-first"))?.models).toBeNull();
  expect((await listed("refresh"))?.audit).toEqual({ remaining: 3, refused: 0 });
  expect(probes).toEqual([]);
  const checked = await listed("audit");
  expect([...(checked?.models?.keys() ?? [])]).toEqual(["gemini-ok"]);
  expect([...(checked?.visibleModels?.keys() ?? [])].sort()).toEqual(["gemini-flaky", "gemini-ok"]);
  expect(checked?.audit).toEqual({ remaining: 1, refused: 1 });
  expect(readSavedProviderModels(access, vertexAccount, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit).toMatchObject({
    dueIds: ["gemini-flaky"], outcomes: { "gemini-ok": "completed", "gemini-flash-latest": "refused" },
  });
  client = createClient();
  probes.length = 0;
  expect([...(await listed("cached-first"))!.models!.keys()]).toEqual(["gemini-ok"]);
  expect(probes).toEqual([]);
  document["google-vertex"].models["gemini-new"] = model("gemini-new");
  await modelsClient.refresh(new AbortController().signal);
  await listed("refresh");
  await listed("audit");
  // The new candidate and the pending one are due, and every pass checks the refused model again (PI-MODEL-084); the
  // completed model is not checked again.
  expect(probes.sort()).toEqual(["gemini-flaky", "gemini-flash-latest", "gemini-new"]);
  probes.length = 0;
  statuses.set("gemini-ok", 500);
  statuses.set("gemini-flash-latest", 200);
  const rechecked = await listed("audit", true);
  expect(probes.sort()).toEqual(["gemini-flaky", "gemini-flash-latest", "gemini-new", "gemini-ok"]);
  expect([...(rechecked?.models?.keys() ?? [])].sort()).toEqual(["gemini-flash-latest", "gemini-new", "gemini-ok"]);
  writeAuth("3b0f6c1e-7a5d-4b0e-8c1f-9a2d4e6f8b10");
  const replaced = { ...auth, credentialLineages: { google_vertex: "3b0f6c1e-7a5d-4b0e-8c1f-9a2d4e6f8b10" } };
  expect((await client.getModelCatalogs(replaced)).candidates.get(accessProviderAccountKey(vertexAccount))?.models).toBeNull();
});

test("SuperGrok lists models.dev candidates as pending, then admits only completed Responses and hides access refusals", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-supergrok-listing-"));
  roots.push(root);
  const access = await new AuthProfileStore(root).create("default");
  access.writeFile("auth.json", JSON.stringify({
    supergrok: [{ id: "primary", identity: "person", lineageId: lineage, credential: { type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: 4_000_000_000_000 } }],
  }));
  const document = modelsDevDocument();
  document.xai = { name: "xAI", npm: "@ai-sdk/xai", models: {
    "grok-ok": model("grok-ok"),
    "grok-paid": model("grok-paid"),
    "grok-flaky": model("grok-flaky"),
    "image-model": { ...model("image-model"), tool_call: false },
  } };
  const responses: { model: string; input: unknown; outputTokens: number; store: boolean; authorization: string | null; tokenAuth: string | null; clientVersion: string | null }[] = [];
  let flaky = 500;
  let modelsRequests = 0;
  let modelsStatus = 200;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("models.dev")) return Response.json(combinedModelsDevProviders(document));
    if (url.endsWith("/models")) {
      modelsRequests += 1;
      if (modelsStatus !== 200) return new Response(null, { status: modelsStatus });
      // Membership from /models is never used, so it lists only an unrelated model.
      return Response.json({ data: [{ id: "grok-unlisted", object: "model" }] });
    }
    const body: { model: string; input: unknown; max_output_tokens: number; store: boolean } = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    responses.push({ model: body.model, input: body.input, outputTokens: body.max_output_tokens, store: body.store, authorization: headers.get("Authorization"), tokenAuth: headers.get("X-XAI-Token-Auth"), clientVersion: headers.get("x-grok-client-version") });
    if (body.model === "grok-paid") return Response.json({ error: "subscription required" }, { status: 402 });
    if (body.model === "grok-flaky" && flaky !== 200) return new Response(null, { status: flaky });
    return Response.json({ status: "completed" });
  }, { preconnect: originalFetch.preconnect });
  const progress: AccessAuditProgress[] = [];
  const modelsClient = createModelsClient(join(root, "models.json"));
  await modelsClient.refresh(new AbortController().signal);
  const client = createModelListingClient({
    classifySlot,
    authDir: access.authDirectory,
    providers: testProviderSelection(),
    modelsClient,
    captureSubscriptions: () => new Map([["supergrok", [{
      instanceId: "primary",
      lineageId: lineage,
      credential: { type: "oauth", access: Redacted.make("xai-access"), refresh: Redacted.make("xai-refresh"), expires: 4_000_000_000_000 },
    }]]]),
  });
  const key = accessProviderAccountKey(account);
  const listed = async (mode: "cached-first" | "fresh" | "refresh" | "audit") => {
    const candidate = (await client.getModelCatalogs(AUTH_NONE, { mode, onAccessAudit: (event) => { progress.push(event); } })).candidates.get(key);
    return { eligible: [...(candidate?.models ?? [])].map(([id]) => id).sort(), visible: [...(candidate?.visibleModels ?? [])].map(([id]) => id).sort() };
  };

  expect(await listed("cached-first")).toEqual({ eligible: [], visible: ["grok-flaky", "grok-ok", "grok-paid"] });
  expect((await client.getModelCatalogs(AUTH_NONE)).candidates.get(key)?.audit).toEqual({ remaining: 3, refused: 0 });
  expect(responses).toEqual([]);
  expect(modelsRequests).toBe(0);

  // Validating the listing (login or refresh) returns the candidates without inference.
  for (const mode of ["fresh", "refresh"] as const) {
    modelsRequests = 0;
    expect(await listed(mode)).toEqual({ eligible: [], visible: ["grok-flaky", "grok-ok", "grok-paid"] });
    expect(modelsRequests).toBe(1);
    expect(responses).toEqual([]);
    expect(progress).toEqual([]);
  }

  // The owned audit fetches no listing and reports each conclusive result.
  modelsRequests = 0;
  expect(await listed("audit")).toEqual({ eligible: ["grok-ok"], visible: ["grok-flaky", "grok-ok"] });
  expect(modelsRequests).toBe(0);
  expect(responses.map((request) => request.model)).toEqual(["grok-flaky", "grok-ok", "grok-paid"]);
  expect(responses[0]).toEqual({ model: "grok-flaky", input: "Reply with only OK.", outputTokens: 256, store: false, authorization: "Bearer xai-access", tokenAuth: "xai-grok-cli", clientVersion: "1.0.45" });
  expect(progress.map((event) => [event.modelId, event.outcome, event.remaining])).toEqual([
    ["grok-ok", "completed", 2], ["grok-paid", "refused", 1],
  ]);
  expect(readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit).toMatchObject({
    dueIds: ["grok-flaky"], outcomes: { "grok-ok": "completed", "grok-paid": "refused" },
  });

  // The durable audit serves a later cached-first listing without inference.
  responses.length = 0;
  expect(await listed("cached-first")).toEqual({ eligible: ["grok-ok"], visible: ["grok-flaky", "grok-ok"] });
  expect(responses).toEqual([]);

  modelsStatus = 503;
  expect(await listed("fresh")).toEqual({ eligible: [], visible: ["grok-flaky", "grok-ok"] });
  expect(readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit).toMatchObject({
    dueIds: ["grok-flaky"], outcomes: { "grok-ok": "completed", "grok-paid": "refused" },
  });
  modelsStatus = 200;

  // A later audit probes what is still due and the refused model again, never the completed one.
  flaky = 200;
  expect(await listed("audit")).toEqual({ eligible: ["grok-flaky", "grok-ok"], visible: ["grok-flaky", "grok-ok"] });
  expect(responses.map((request) => request.model)).toEqual(["grok-flaky", "grok-paid"]);

  // An invalidated connection still exposes models.dev preferences, without routing any model.
  modelsStatus = 401;
  expect(await listed("refresh")).toEqual({ eligible: [], visible: ["grok-flaky", "grok-ok", "grok-paid"] });
  expect(readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit).toBeUndefined();
});

test("a manual SuperGrok recheck probes every candidate of the exact account, keeps prior successes through transient answers, restores refused models, and refuses a stale lineage", async () => {
  const otherLineage = "0d5f4f7e-5a1c-4d3c-9d6f-2f0f0c1f6a11";
  const root = mkdtempSync(join(tmpdir(), "flywheel-supergrok-recheck-"));
  roots.push(root);
  const access = await new AuthProfileStore(root).create("default");
  const writeAuth = (primaryLineage: string) => access.writeFile("auth.json", JSON.stringify({
    supergrok: [
      { id: "primary", identity: "person", lineageId: primaryLineage, credential: { type: "oauth", access: "xai-access", refresh: "xai-refresh", expires: 4_000_000_000_000 } },
      { id: "secondary", identity: "other", lineageId: otherLineage, credential: { type: "oauth", access: "xai-other", refresh: "xai-other-refresh", expires: 4_000_000_000_000 } },
    ],
  }));
  writeAuth(lineage);
  const document = modelsDevDocument();
  document.xai = { name: "xAI", npm: "@ai-sdk/xai", models: { "grok-ok": model("grok-ok"), "grok-paid": model("grok-paid"), "grok-flaky": model("grok-flaky") } };
  const statuses = new Map([["grok-ok", 200], ["grok-paid", 402], ["grok-flaky", 200]]);
  const probes: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("models.dev")) return Response.json(combinedModelsDevProviders(document));
    if (url.endsWith("/models")) return Response.json({ data: [] });
    const body: { model: string } = JSON.parse(String(init?.body));
    probes.push(`${new Headers(init?.headers).get("Authorization")}:${body.model}`);
    const status = statuses.get(body.model) ?? 500;
    return status === 200 ? Response.json({ status: "completed" }) : new Response(null, { status });
  }, { preconnect: originalFetch.preconnect });
  const modelsClient = createModelsClient(join(root, "models.json"));
  await modelsClient.refresh(new AbortController().signal);
  const credential = (token: string) => ({ type: "oauth", access: Redacted.make(token), refresh: Redacted.make(`${token}-refresh`), expires: 4_000_000_000_000 }) as const;
  const client = createModelListingClient({
    classifySlot,
    authDir: access.authDirectory,
    providers: testProviderSelection(),
    modelsClient,
    captureSubscriptions: () => new Map([["supergrok", [
      { instanceId: "primary", lineageId: lineage, credential: credential("xai-access") },
      { instanceId: "secondary", lineageId: otherLineage, credential: credential("xai-other") },
    ]]]),
  });
  const list = (mode: "fresh" | "audit", recheckAccount?: typeof account) => client.getModelCatalogs(AUTH_NONE, { mode, ...(recheckAccount === undefined ? {} : { recheckAccount }) });
  const audit = () => readSavedProviderModels(access, account, lineage, DEFAULT_DYNAMIC_CATALOG_LIMITS)?.audit;

  await list("fresh");
  await list("audit");
  expect(audit()).toMatchObject({ dueIds: [], outcomes: { "grok-ok": "completed", "grok-flaky": "completed", "grok-paid": "refused" } });

  // The recheck probes the refused model too, and only the named account.
  probes.length = 0;
  statuses.set("grok-ok", 500);
  statuses.set("grok-paid", 200);
  const rechecked = (await list("audit", account)).candidates.get(accessProviderAccountKey(account));
  expect(probes.sort()).toEqual(["Bearer xai-access:grok-flaky", "Bearer xai-access:grok-ok", "Bearer xai-access:grok-paid"]);
  expect(audit()).toMatchObject({ dueIds: ["grok-ok"], outcomes: { "grok-ok": "completed", "grok-flaky": "completed", "grok-paid": "completed" } });
  expect([...(rechecked?.models ?? [])].map(([id]) => id).sort()).toEqual(["grok-flaky", "grok-ok", "grok-paid"]);

  // A credential lineage that no longer matches auth.json writes and probes nothing.
  probes.length = 0;
  const generation = audit()?.generation;
  writeAuth("3b0f6c1e-7a5d-4b0e-8c1f-9a2d4e6f8b10");
  await list("audit", account);
  writeAuth(lineage);
  expect(probes).toEqual([]);
  expect(audit()?.generation).toBe(generation);
});

test("a snapshot's carried SuperGrok checks admit nothing once its access token has expired", async () => {
  const root = mkdtempSync(join(tmpdir(), "flywheel-supergrok-snapshot-"));
  roots.push(root);
  const access = await new AuthProfileStore(root).create("default");
  const document = modelsDevDocument();
  document.xai = { name: "xAI", npm: "@ai-sdk/xai", models: { "grok-ok": model("grok-ok") } };
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("models.dev")) return Response.json(combinedModelsDevProviders(document));
    return url.endsWith("/models") ? Response.json({ data: [{ id: "grok-ok", object: "model" }] }) : Response.json({ status: "completed" });
  }, { preconnect: originalFetch.preconnect });
  const modelsClient = createModelsClient(join(root, "models.json"));
  await modelsClient.refresh(new AbortController().signal);
  requests.length = 0;
  const listing = (expires: number) => createModelListingClient({
    classifySlot,
    authDir: access.authDirectory,
    providers: testProviderSelection(),
    modelsClient,
    oauthPersistence: "access-only",
    modelAccess: [{ account, lineage, outcomes: { "grok-ok": "completed" } }],
    captureSubscriptions: () => new Map([["supergrok", [{
      instanceId: "primary",
      lineageId: lineage,
      credential: { type: "oauth", access: Redacted.make("xai-access"), refresh: Redacted.make("xai-refresh"), expires },
    }]]]),
  }).getModelCatalogs(AUTH_NONE, { mode: "fresh" }).then((catalogs) => catalogs.candidates.get(accessProviderAccountKey(account)));

  expect((await listing(4_000_000_000_000))?.models?.has("grok-ok")).toBe(true);
  const expired = await listing(1);
  expect(expired?.models).toBeNull();
  expect(expired?.outcome).toEqual({ kind: "unavailable", reason: "authentication-invalid" });
  expect(requests.some((url) => url.includes("/responses"))).toBe(false);
});
