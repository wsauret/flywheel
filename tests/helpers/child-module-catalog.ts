import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** The first statement of a script that a test writes and runs as its own
 *  process. Such a process does not run the test preload, and no kernel file
 *  loads a module registry, so before the script reads the module catalog it
 *  must publish the shipped catalog the way a process entry of the binary does
 *  (`src/cli/composition/module-registries.ts`). A static import evaluates
 *  before every import that follows it. */
export const LOAD_SHIPPED_CATALOG = `import ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../../scripts/shipped-modules.ts")).href)};`
