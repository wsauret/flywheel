import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModelsClient } from "../../../../src/infra/llm/models.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

interface CatalogModels {
  readonly [model: string]: { readonly id: string; readonly family?: string; readonly name?: string };
}

function modelsDocument(models: CatalogModels): string {
  const providers = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const provider = index === 0 ? "anthropic" : `provider-${index}`;
    return [provider, { name: provider, models: index === 0 ? models : { [`model-${index}`]: { id: `model-${index}` } } }];
  }));
  const modelMap = Object.fromEntries(Object.entries(providers).flatMap(([providerId, provider]) =>
    Object.values(provider.models).map((model) => {
      const identity = `${providerId}/${model.id}`;
      return [identity, { ...model, id: identity }];
    })));
  return JSON.stringify({ models: modelMap, providers });
}

function snapshotFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-model-tokenizer-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "models.json");
}

/** Replaces models.dev with a server that accepts every request and never answers. */
function unreachableModelsDev() {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1;
      return new Promise<Response>(() => {});
    },
    { preconnect: originalFetch.preconnect },
  );
  return { requests: () => requests };
}

function archivedClientFor(models: CatalogModels) {
  const file = snapshotFile();
  fs.writeFileSync(file, modelsDocument(models));
  unreachableModelsDev();
  return createModelsClient(file);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Anthropic catalog tokenizer resolution", () => {
  test("maps cataloged Claude families and supported generations", () => {
    const client = archivedClientFor({
      "claude-opus-4-6": { id: "claude-opus-4-6", family: "claude-opus" },
      "claude-opus-4-7": { id: "claude-opus-4-7", family: "claude-opus" },
      "claude-opus-5-1": { id: "claude-opus-5-1", family: "claude-opus" },
      "claude-sonnet-4-6": { id: "claude-sonnet-4-6", family: "claude-sonnet" },
      "claude-sonnet-5-2": { id: "claude-sonnet-5-2", family: "claude-sonnet" },
      "claude-haiku-5-1": { id: "claude-haiku-5-1", family: "claude-haiku" },
      "claude-fable-5-1": { id: "claude-fable-5-1", family: "claude-fable" },
    });

    expect(client.getTokenizerIdentity("claude-opus-4.6")).toBe("ClaudeV3");
    expect(client.getTokenizerIdentity("claude-opus-4.7")).toBe("ClaudeV47");
    expect(client.getTokenizerIdentity("claude-opus-5.1")).toBe("ClaudeV5");
    expect(client.getTokenizerIdentity("claude-sonnet-4.6")).toBe("ClaudeV3");
    expect(client.getTokenizerIdentity("claude-sonnet-5.2")).toBe("ClaudeV5Sonnet");
    expect(client.getTokenizerIdentity("claude-haiku-5.1")).toBe("ClaudeV5Sonnet");
    expect(client.getTokenizerIdentity("claude-fable-5.1")).toBe("ClaudeV5Sonnet");
  });

  test("requires Anthropic membership and a packaged generation", () => {
    const client = archivedClientFor({
      "claude-opus-6": { id: "claude-opus-6", family: "claude-opus" },
      "claude-opus-distill-5": { id: "claude-opus-distill-5", family: "claude-opus" },
      "fabled-opus-5": { id: "fabled-opus-5", family: "claude-opus" },
      "friendly-model": { id: "friendly-model", family: "other", name: "Claude Opus 5" },
    });

    expect(client.getTokenizerIdentity("claude-opus-6")).toBeUndefined();
    expect(client.getTokenizerIdentity("claude-opus-distill-5")).toBeUndefined();
    expect(client.getTokenizerIdentity("fabled-opus-5")).toBeUndefined();
    expect(client.getTokenizerIdentity("friendly-model")).toBeUndefined();
    expect(client.getTokenizerIdentity("claude-opus-5")).toBeUndefined();
  });

  test("resolves from the bundled catalog without a models.dev request when no archive exists", () => {
    const modelsDev = unreachableModelsDev();
    const client = createModelsClient(snapshotFile());

    expect(client.getTokenizerIdentity("claude-opus-4.7")).toBe("ClaudeV47");
    expect(client.getTokenizerIdentity("claude-sonnet-4.6")).toBe("ClaudeV3");
    expect(modelsDev.requests()).toBe(0);
  });

  test("resolves a Claude model newer than the current catalog after a refresh publishes it", async () => {
    const client = createModelsClient(snapshotFile());
    expect(client.getTokenizerIdentity("claude-opus-5.9")).toBeUndefined();

    globalThis.fetch = Object.assign(
      async () => new Response(modelsDocument({ "claude-opus-5-9": { id: "claude-opus-5-9", family: "claude-opus" } }), { status: 200 }),
      { preconnect: originalFetch.preconnect },
    );
    await client.refresh(new AbortController().signal);

    expect(client.getTokenizerIdentity("claude-opus-5.9")).toBe("ClaudeV5");
  });
});
