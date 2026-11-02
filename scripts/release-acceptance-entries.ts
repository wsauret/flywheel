/** The files of a served client's source that the acceptance driver
 *  (`release-acceptance-driver.ts`) imports, by the role each plays there.
 *  The release gate (`release-acceptance.ts`) starts each tag's updater
 *  generation from the same files, so the two cannot name different ones.
 *  This module imports nothing, so the driver loads no code of this tree
 *  beside the client's own. */
export const SHIPPED_ENTRY_POINTS = {
  check: "src/orchestration/update/update-check.ts",
  manifest: "src/infra/update/release-manifest.ts",
  version: "src/infra/update/version-order.ts",
  identity: "src/infra/update/build-identity.ts",
  install: "src/orchestration/update/update-install.ts",
  contract: "scripts/release-contract.ts",
  installation: "src/protocol/installation.ts",
} as const;
