// Module internals live in their declared homes. This empty ledger is a
// permanent contract: new capabilities extend registries, never exceptions.
// The locality and import boundary gates reject every unowned reference.

export interface ModuleContainmentAllowance {
  readonly path: string;
  readonly literal: string;
  readonly unit: number;
}

export const MODULE_CONTAINMENT_ALLOWLIST: readonly ModuleContainmentAllowance[] = [];
