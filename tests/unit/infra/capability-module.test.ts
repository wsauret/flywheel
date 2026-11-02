import { describe, expect, test } from "bun:test";
import { composeModules, type ModuleDescriptor } from "../../../src/infra/module-descriptor.js";

interface Contributions {
  readonly tools: { readonly name: string };
  readonly prompts: { readonly text: string };
}
interface Observers { readonly turn: (event: string) => void }
interface Transformers { readonly prompt: (value: string) => string }
interface Gates { readonly execution: (input: string) => boolean }

type Module = ModuleDescriptor<Contributions, Observers, Transformers, Gates>;

const core = {
  id: "core",
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "tools", id: "read", value: { name: "read" } },
    { domain: "prompts", id: "core", value: { text: "core" } },
  ],
  observers: [{ seam: "turn", observer: (_event: string) => undefined }],
  transformers: [{ seam: "prompt", id: "core", order: 20, transformer: (value: string) => `${value}:core` }],
  gates: [],
} as const satisfies Module;

const extension = {
  id: "extension",
  dependencies: ["core"],
  availability: { kind: "available" },
  contributions: [{ domain: "tools", id: "write", value: { name: "write" } }],
  observers: [],
  transformers: [{ seam: "prompt", id: "extension", order: 10, transformer: (value: string) => `${value}:extension` }],
  gates: [{ seam: "execution", gate: (_input: string) => true }],
} as const satisfies Module;

describe("capability module composition", () => {
  test("is independent of catalog order and sorts domains, ids, and transformers", () => {
    const forward = composeModules([core, extension]);
    const reverse = composeModules([extension, core]);
    expect(reverse).toEqual(forward);
    expect(forward.enabledModuleIds).toEqual(["core", "extension"]);
    expect(forward.contributions.map(({ domain, id }) => `${String(domain)}:${id}`)).toEqual(["prompts:core", "tools:read", "tools:write"]);
    expect(forward.transformers.map(({ id }) => id)).toEqual(["extension", "core"]);
  });

  test("removes every declaration from a disabled module", () => {
    const result = composeModules([core, extension], { disabledModuleIds: ["extension"] });
    expect(result.enabledModuleIds).toEqual(["core"]);
    expect(result.contributions.map(({ id }) => id)).toEqual(["core", "read"]);
    expect(result.gates).toEqual([]);
  });

  test("validates dependencies and cycles in disabled modules", () => {
    const unknownDependency = { ...extension, dependencies: ["missing"] } as const satisfies Module;
    expect(() => composeModules([core, unknownDependency], { disabledModuleIds: ["extension"] })).toThrow("extension requires unknown module missing");

    const cyclic = [
      { ...core, id: "a", dependencies: ["b"] },
      { ...extension, id: "b", dependencies: ["a"] },
    ] as const satisfies readonly Module[];
    expect(() => composeModules(cyclic, { disabledModuleIds: ["a", "b"] })).toThrow("Capability module dependency cycle: a -> b -> a");
  });

  test("rejects duplicate module, contribution, and gate identities", () => {
    expect(() => composeModules([core, core])).toThrow("Duplicate capability module id: core");
    expect(() => composeModules([core, { ...extension, contributions: [{ domain: "tools", id: "read", value: { name: "other" } }] }])).toThrow("Duplicate tools contribution id: read");
    expect(() => composeModules([extension, { ...core, gates: [{ seam: "execution", gate: (_input: string) => false }] }])).toThrow("Duplicate gate for seam: execution");
  });

  test("rejects duplicate transformer identities across the complete catalog", () => {
    const duplicate = {
      ...extension,
      transformers: [{ seam: "prompt", id: "core", order: 10, transformer: (value: string) => value }],
    } as const satisfies Module;
    expect(() => composeModules([core, duplicate], { disabledModuleIds: ["extension"] })).toThrow("Duplicate transformer for seam prompt and id: core");
  });

  test("warns instead of rejecting explicitly degraded contribution domains", () => {
    const result = composeModules([core], { disabledModuleIds: ["core"], warnWhenEmpty: ["tools", "prompts"] });
    expect(result.warnings).toEqual(["No prompts contributions are enabled", "No tools contributions are enabled"]);
  });
});
