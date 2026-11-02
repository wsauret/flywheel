import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findProviderModelLiteralViolations } from "../../../scripts/check-provider-model-literals.js";
import { temporaryDirectories } from "../../helpers/directories.js";

interface FileSources {
  readonly [path: string]: string;
}

const temporaryDirectory = temporaryDirectories();

async function check(files: FileSources) {
  const root = temporaryDirectory("flywheel-provider-model-literals-");
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return await findProviderModelLiteralViolations(root);
}

describe("provider model literal policy", () => {
  it("rejects maintained membership, alias, and protocol rules", async () => {
    const violations = await check({
      "src/orchestration/modules/provider-example/model-support.ts": [
        "const MODEL_ALLOWLIST = ['model-a', 'model-b']",
        "const VENDOR_ALIASES = { acme: 'acme-ai' }",
        "export const supports = (modelId: string) => MODEL_ALLOWLIST.includes(modelId)",
        "export const protocol = (modelId: string) => modelId.startsWith('claude-') ? 'anthropic' : 'openai'",
      ].join("\n"),
      "src/infra/llm/example-routing.ts": [
        "const modelFamilyPatterns = [{ family: 'openai', pattern: /^gpt-/i }]",
        "const route = MODEL_ID.toLowerCase().match(/^claude-/) ? 'anthropic' : 'openai'",
      ].join("\n"),
    });
    expect(violations.map(({ rule }) => rule)).toEqual([
      "no-maintained-model-list",
      "no-maintained-model-list",
      "no-maintained-vendor-aliases",
      "no-model-id-routing-branch",
    ]);
  });

  it("permits namespaces, capability routing, generated data, custom config, and annotated payload compatibility", async () => {
    expect(await check({
      "src/orchestration/modules/provider-example/module.ts": [
        "const modelsDevCatalogIds = ['example']",
        "const endpoint = metadata.supportedEndpoints.includes('/responses') ? 'openai-responses' : 'openai-completions'",
        "const payload = modelId === 'o3' ? { reasoning_effort: 'high' } : {} // provider-model-literal-allow: payload -- provider payload compatibility",
        "const identity = wireModelId.endsWith(':free') ? 'free' : 'default' // provider-model-literal-allow: identity -- provider catalog grammar",
      ].join("\n"),
      "src/orchestration/config/custom-provider.ts": "const models = config.models",
      "src/infra/llm/models-bundled.txt": "example:model-a",
    })).toEqual([]);
  });

  it("catches authority rules beside an annotated payload operation", async () => {
    const violations = await check({
      "src/orchestration/custom-provider-modules.ts": [
        "const payload = modelId === 'o3' ? {} : {} // provider-model-literal-allow: payload -- wire payload compatibility",
        "const route = modelId.startsWith('claude-') ? 'anthropic' : 'openai'",
      ].join("\n"),
    });
    expect(violations).toEqual([expect.objectContaining({ line: 2, rule: "no-model-id-routing-branch" })]);
  });

  it("rejects typed and standalone regex authorities across lines", async () => {
    const violations = await check({
      "src/orchestration/config/model-policy.ts": [
        "const MODEL_FAMILY_PATTERNS: readonly { family: string; pattern: RegExp }[] = [",
        "  { family: 'openai', pattern: /^gpt-/ },",
        "]",
        "const UNSUPPORTED_SELECTABLE_MODEL_PATTERNS: readonly RegExp[] = [/^audio-/]",
        "const GATEWAY_ANTHROPIC_RE = /^claude-/",
        "export function family(model: string) {",
        "  return GATEWAY_ANTHROPIC_RE.test(",
        "    model,",
        "  ) ? 'anthropic' : 'openai'",
        "}",
      ].join("\n"),
    });

    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ detail: "MODEL_FAMILY_PATTERNS", rule: "no-maintained-model-list" }),
      expect.objectContaining({ detail: "UNSUPPORTED_SELECTABLE_MODEL_PATTERNS", rule: "no-maintained-model-list" }),
      expect.objectContaining({ detail: "GATEWAY_ANTHROPIC_RE", rule: "no-maintained-model-list" }),
      expect.objectContaining({ rule: "no-model-id-routing-branch" }),
    ]));
  });
});
