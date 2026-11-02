import { expectTypeOf, test } from "bun:test";
import type { ModuleDescriptor } from "../../../src/infra/module-descriptor.js";

interface Contributions { readonly tools: { readonly name: string } }
interface Observers { readonly turn: (event: string) => void }
interface Transformers { readonly prompt: (value: string) => string }
interface Gates { readonly execution: (input: string) => boolean }

test("ModuleDescriptor preserves owner-defined contribution and hook types", () => {
  const module = {
    id: "typed",
    dependencies: [],
    availability: { kind: "available" },
    contributions: [{ domain: "tools", id: "read", value: { name: "read" } }],
    observers: [{ seam: "turn", observer: (_event: string) => undefined }],
    transformers: [{ seam: "prompt", id: "typed", order: 1, transformer: (value: string) => value }],
    gates: [{ seam: "execution", gate: (_input: string) => true }],
  } as const satisfies ModuleDescriptor<Contributions, Observers, Transformers, Gates>;

  expectTypeOf(module.contributions[0].value.name).toEqualTypeOf<"read">();
  expectTypeOf(module.transformers[0].order).toEqualTypeOf<1>();
});
