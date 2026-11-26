/** Loads the module registries, which publish the shipped catalog that every
 *  composition reads (`orchestration/module-contract/module-catalog.ts`). No kernel file
 *  imports a registry, so a process loads them here, once, before it loads
 *  code that reads the catalog. A source or test entry that installed its own
 *  catalog keeps it: publishing never replaces an installed override.
 *
 *  The load is a dynamic import on purpose. A compiled executable splits its
 *  code into chunks, and a `require` of a chunk there evaluates a second copy
 *  of the modules the chunks share, so the catalog it would publish is not
 *  the one the kernel reads. */
async function loadModuleRegistries(): Promise<void> {
  await Promise.all([import("../../orchestration/credential-provider-modules.js"), import("../../orchestration/modules.js")])
}

/** Loads code that reads the module catalog, after the registries that
 *  publish it. Every dynamic import of such code from a process entry goes
 *  through this call; `tests/unit/cli/module-registry-loading.test.ts`
 *  fails one that does not. */
export async function importComposing<Module>(load: () => Promise<Module>): Promise<Module> {
  await loadModuleRegistries()
  return await load()
}
