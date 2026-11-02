import { describe, expect, it } from "bun:test";
import { checkModelCatalog } from "../../../scripts/check-model-catalog.js";
import { prepareBundledModelsSnapshot } from "../../../scripts/refresh-models-snapshot.js";
import { admitModelsDocument } from "../../../src/infra/llm/models-document.js";
import type { MutableCombinedModelsDevDocument } from "../../helpers/model-catalog-fixtures.js";

interface ModelDocument {
  [key: string]: { id: string; name?: string };
}

function document(models: ModelDocument): MutableCombinedModelsDevDocument {
  const providers = {
    openrouter: { name: "OpenRouter", models },
    "x-ai": { name: "xAI", models: { grok: { id: "grok-4", name: "Grok 4" } } },
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`provider-${index}`, { name: `Provider ${index}`, models: { example: { id: `example-${index}` } } }])),
    anthropic: { name: "Anthropic", models: { example: { id: "claude-example" } } },
  } satisfies { [providerId: string]: { name: string; models: ModelDocument } };
  const modelMap = Object.fromEntries(Object.values(models).map((model) => {
    const identity = model.id.replace(/-contributor$/, "");
    return [identity, { ...model, id: identity }];
  }));
  return { models: modelMap, providers };
}

function admitted(candidate: ReturnType<typeof document>) {
  return admitModelsDocument(JSON.stringify(candidate));
}

describe("model catalog publication check", () => {
  it("removes retired identities and relationships but preserves versionless aliases without retired descriptions", () => {
    const retiredGeneration = [5, 6].join(".");
    const adjacentGeneration = [5, 60].join(".");
    const retired = `gpt-${retiredGeneration}-luna`;
    const adjacent = `gpt-${adjacentGeneration}`;
    const candidate = document({
      [retired]: { id: retired, name: "Retired" },
      current: { id: "gpt-6-luna", name: "Current" },
      wire: { id: `openai/${retired.replace(".", "-")}-2026-01-01-contributor`, name: "Retired wire" },
      adjacent: { id: adjacent, name: "Adjacent generation" },
    });
    const alias = { id: "gpt-luna-latest", name: "Alias", description: `Compatibility alias for GPT ${retiredGeneration} Luna.`, provider: { npm: "transport-package" }, limit: { context: 100_000 } };
    const linked = { id: "gpt-other-latest", name: "Linked", canonical_model_id: `openai/${retired}` };
    const currentAlias = { id: "gpt-current-latest", name: "Current alias", canonical_model_id: "openai/gpt-6-luna", description: "Current generation." };
    candidate.providers["openai"] = { name: "OpenAI", models: { alias, linked, currentAlias } };
    const snapshot = prepareBundledModelsSnapshot(new TextEncoder().encode(JSON.stringify(candidate)));
    const generated: unknown = JSON.parse(snapshot);
    expect(generated).not.toHaveProperty(["models", retired]);
    expect(generated).not.toHaveProperty(["providers", "openrouter", "models", retired]);
    expect(generated).not.toHaveProperty(["providers", "openrouter", "models", "wire"]);
    expect(generated).not.toHaveProperty(["providers", "openai", "models", "linked"]);
    expect(generated).toMatchObject({
      models: { "gpt-6-luna": { id: "gpt-6-luna" }, [adjacent]: { id: adjacent } },
      providers: { openai: { models: { alias: { id: alias.id, name: alias.name, provider: alias.provider, limit: alias.limit }, currentAlias } } },
    });
    expect(generated).not.toHaveProperty(["providers", "openai", "models", "alias", "description"]);
    expect(admitModelsDocument(snapshot).relationshipAuthority).toBe("model-map");
  });

  it("uses model-map identity despite conflicting provider-catalog rows", () => {
    const candidate = document({ odd: { id: "x-ai/grok-4", name: "Grok 4" } });
    const xai = candidate.providers["x-ai"];
    const grok = xai?.models.grok;
    if (grok === undefined) throw new Error("Expected xAI Grok fixture");
    grok.id = "grok-5";
    const issues = checkModelCatalog(admitted(candidate));
    expect(issues).toEqual([]);
  });

  it("reports terminal contributor rows that remain standard", () => {
    const issues = checkModelCatalog(admitted(document({ muse: { id: "meta/muse-1-contributor", name: "Muse" } })));
    expect(issues.some((issue) => issue.kind === "unclassified-terminal-contributor")).toBe(false);
    const malformed = checkModelCatalog(admitted(document({ muse: { id: "meta/muse-1-contributor-free", name: "Muse" } })));
    expect(malformed).toContainEqual({
      kind: "unclassified-terminal-contributor",
      providerId: "openrouter",
      wireModelId: "meta/muse-1-contributor-free",
    });
  });

  it("reports duplicate display labels that select distinct canonical models", () => {
    const candidate = {
      ...document({
        first: { id: "qwen/qwen-3", name: "Qwen" },
        second: { id: "qwen/qwen-4", name: "Qwen" },
      }),
    };
    candidate.providers["qwen"] = { name: "Qwen", models: {
        first: { id: "qwen-3", name: "Qwen 3" },
        second: { id: "qwen-4", name: "Qwen 4" },
      } };
    const issues = checkModelCatalog(admitted(candidate));
    expect(issues).toContainEqual({
      kind: "duplicate-display-label",
      providerId: "openrouter",
      displayLabel: "Qwen",
      canonicalModelIds: ["qwen-3", "qwen-4"],
    });
  });
});
