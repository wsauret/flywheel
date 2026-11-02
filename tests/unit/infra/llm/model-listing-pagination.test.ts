import { expect, test } from "bun:test";
import { fetchCatalog, fetchPaginatedCatalog } from "../../../../src/infra/llm/model-listing.js";
import { TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";

function paginationRows(body: unknown): readonly unknown[] {
  return typeof body === "object" && body !== null && "rows" in body && Array.isArray(body.rows) ? body.rows : [];
}

test("provider listing retains the HTTP status without reading or logging the response body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response("private provider response", { status: 503 }), { preconnect: original.preconnect });
  try {
    const result = await fetchCatalog("https://catalog.test/models", {}, { limits: TEST_CATALOG_LIMITS, extractRows: paginationRows }, new AbortController().signal);
    expect(result).toEqual({ kind: "failed", reason: "http", status: 503 });
  } finally {
    globalThis.fetch = original;
  }
});

test("unpaginated catalog rejects source row overflow before aliases collapse", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json([
    { id: "gpt-6.1-sol" },
    { id: "gpt-6-1-sol" },
    { id: "gpt_6_1_sol" },
    { id: "GPT 6 1 SOL" },
  ]), { preconnect: original.preconnect });
  try {
    const result = await fetchCatalog("https://catalog.test/models", {}, {
      limits: { ...TEST_CATALOG_LIMITS, canonicalRows: 3 },
      extractRows: (body) => Array.isArray(body) ? body : [],
    }, new AbortController().signal);
    expect(result).toEqual({ kind: "failed", reason: "oversized" });
  } finally {
    globalThis.fetch = original;
  }
});

test("paginated catalog rejects a repeated cursor as malformed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ rows: [], next: "same" }), { preconnect: original.preconnect });
  try {
    const result = await fetchPaginatedCatalog("https://catalog.test/models", {}, { limits: { ...TEST_CATALOG_LIMITS, canonicalRows: 3 }, extractRows: paginationRows }, new AbortController().signal, () => "https://catalog.test/models");
    expect(result).toEqual({ kind: "failed", reason: "malformed" });
  } finally {
    globalThis.fetch = original;
  }
});

test("paginated catalog bounds unique endless pages", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {
    requests += 1;
    return Response.json({ rows: [] });
  }, { preconnect: original.preconnect });
  try {
    const result = await fetchPaginatedCatalog("https://catalog.test/models?page=0", {}, { limits: { ...TEST_CATALOG_LIMITS, canonicalRows: 3 }, extractRows: paginationRows }, new AbortController().signal, (_body, currentUrl) => `https://catalog.test/models?page=${Number(new URL(currentUrl).searchParams.get("page")) + 1}`);
    expect(result).toEqual({ kind: "failed", reason: "malformed" });
    expect(requests).toBe(3);
  } finally {
    globalThis.fetch = original;
  }
});

test("paginated catalog enforces one aggregate response byte budget", async () => {
  const original = globalThis.fetch;
  let page = 0;
  globalThis.fetch = Object.assign(async () => {
    page += 1;
    return Response.json({ rows: [{ id: `model-${page}` }], next: page === 1 ? "next" : null });
  }, { preconnect: original.preconnect });
  try {
    const result = await fetchPaginatedCatalog("https://catalog.test/models?page=1", {}, { limits: { ...TEST_CATALOG_LIMITS, responseBytes: 70 }, extractRows: paginationRows }, new AbortController().signal, (_body, currentUrl) => currentUrl.endsWith("1") ? "https://catalog.test/models?page=2" : undefined);
    expect(result).toEqual({ kind: "failed", reason: "oversized" });
    expect(page).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("caller cancellation interrupts active pagination", async () => {
  const original = globalThis.fetch;
  let settled = false;
  globalThis.fetch = Object.assign((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => {
      settled = true;
      reject(init?.signal?.reason);
    };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  }), { preconnect: original.preconnect });
  try {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const pending = fetchPaginatedCatalog("https://catalog.test/models", {}, { limits: TEST_CATALOG_LIMITS, extractRows: () => [] }, controller.signal, () => undefined);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(settled).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});
