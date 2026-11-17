import { expectTypeOf, test } from "bun:test";
import type { ModuleDescriptor } from "../../../src/infra/module-descriptor.js";

interface Contributions { readonly tools: { readonly name: string } }
interface Observers { readonly turn: (event: string) => void }
interface Gates { readonly execution: (input: string) => boolean }

test("ModuleDescriptor preserves owner-defined contribution and hook types", () => {
  const module = {
    id: "typed",
    dependencies: [],
    availability: { kind: "available" },
    contributions: [{ domain: "tools", id: "read", value: { name: "read" } }],
    observers: [{ seam: "turn", observer: (_event: string) => undefined }],
    gates: [{ seam: "execution", gate: (_input: string) => true }],
  } as const satisfies ModuleDescriptor<Contributions, Observers, Gates>;

  expectTypeOf(module.contributions[0].value.name).toEqualTypeOf<"read">();
  expectTypeOf(module.gates[0].seam).toEqualTypeOf<"execution">();
});
