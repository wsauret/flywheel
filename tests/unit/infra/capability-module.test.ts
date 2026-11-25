import { describe, expect, test } from "bun:test";
import { composeModules, type ModuleDescriptor } from "../../../src/infra/definitions/module-descriptor.js";

interface Contributions {
  readonly tools: { readonly name: string };
  readonly prompts: { readonly text: string };
}
interface Observers { readonly turn: (event: string) => void }
interface Gates { readonly execution: (input: string) => boolean }

type Module = ModuleDescriptor<Contributions, Observers, Gates>;

const core = {
  id: "core",
  dependencies: [],
  contributions: [
    { domain: "tools", id: "read", value: { name: "read" } },
    { domain: "prompts", id: "core", value: { text: "core" } },
  ],
  observers: [{ seam: "turn", observer: (_event: string) => undefined }],
} as const satisfies Module;

const extension = {
  id: "extension",
  dependencies: ["core"],
  contributions: [{ domain: "tools", id: "write", value: { name: "write" } }],
  gates: [{ seam: "execution", gate: (_input: string) => true }],
} as const satisfies Module;

describe("capability module composition", () => {
  test("is independent of catalog order and sorts domains and ids", () => {
    const forward = composeModules([core, extension]);
    const reverse = composeModules([extension, core]);
    expect(reverse).toEqual(forward);
    expect(forward.enabledModuleIds).toEqual(["core", "extension"]);
    expect(forward.contributions.map(({ domain, id }) => `${String(domain)}:${id}`)).toEqual(["prompts:core", "tools:read", "tools:write"]);
  });

  test("removes every declaration from a disabled module", () => {
    const result = composeModules([core, extension], { disabledModuleIds: ["extension"] });
    expect(result.enabledModuleIds).toEqual(["core"]);
    expect(result.contributions.map(({ id }) => id)).toEqual(["core", "read"]);
    expect(result.gates).toEqual([]);
  });

  test("a descriptor without observers or gates composes with none, and a gate composes as the one gate of its seam", () => {
    const plain = { id: "plain", dependencies: [], contributions: [] } as const satisfies Module;
    expect(composeModules([plain])).toMatchObject({ enabledModuleIds: ["plain"], observers: [], gates: [] });
    const result = composeModules([plain, core, extension]);
    expect(result.gates.map(({ seam }) => seam)).toEqual(["execution"]);
    expect(result.observers.map(({ seam }) => seam)).toEqual(["turn"]);
  });

  test("a module whose dependency is off is off in the effective selection", () => {
    const result = composeModules([core, extension], { disabledModuleIds: ["core"] });
    expect(result.enabledModuleIds).toEqual([]);
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

  test("warns instead of rejecting explicitly degraded contribution domains", () => {
    const result = composeModules([core], { disabledModuleIds: ["core"], warnWhenEmpty: ["tools", "prompts"] });
    expect(result.warnings).toEqual(["No prompts contributions are enabled", "No tools contributions are enabled"]);
  });
});
