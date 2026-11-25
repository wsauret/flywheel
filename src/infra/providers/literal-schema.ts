import { Schema } from "effect";

/** Builds a strict literal schema from the identities installed by the owning registry. */
export function createInstalledIdSchema<const Id extends string>(installedIds: readonly Id[]) {
  return Schema.Literals(installedIds);
}
