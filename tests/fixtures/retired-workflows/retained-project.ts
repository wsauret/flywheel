import { cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js"
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js"
import { installedPersonaToolEntries } from "../../../src/orchestration/tool-catalog.js"
import { testAccountHome, testDirectories } from "../../helpers/directories.js"
import { repoModules } from "../../helpers/project-definitions.js"
import { retiredBuiltInText } from "../../../src/workflows/vm/retired-built-in-definitions.js"

/** Person-kept copies of the last step-grammar implement and qa workflows,
 * and the phase-grammar debug workflow and briefs from 64d9b75aea.
 * The raindrop-audit workflow, brief, and contract are from a9128a8bbd, and
 * the fly.raindrop-audit package that its brief composes is from ebda5cf6ec,
 * the last revision before the development bundle stopped shipping it.
 * The implement briefs and package are from abcef182df; qa.yaml is the
 * 301e51b8b text of src/workflows/vm/retired-built-in-definitions.ts, and its
 * briefs are from f6d747a6f3. The history tests depend on these exact bytes,
 * so change none of them. The step grammar preserves the
 * identity evidence that a project-layer phase-grammar copy does not carry.
 * The test account owns cleanup because migration fixtures share this
 * project across test files in the same process. The legacy options
 * supply frozen step-grammar views for pre-phase identity tests. */
export function retainedProject(options: { readonly legacyDebug?: boolean; readonly legacyRaindropAudit?: boolean } = {}) {
  const root = mkdtempSync(join(testAccountHome(), "retained-workflows-"))
  // The repository ignores `.flywheel/`, so the fixture keeps the folder's
  // contents under a plain name and copies them into place.
  cpSync(join(import.meta.dir, "retained-project"), join(root, ".flywheel"), { recursive: true })
  for (const id of [...(options.legacyDebug ? ["debug"] : []), ...(options.legacyRaindropAudit ? ["raindrop-audit"] : [])]) {
    const text = retiredBuiltInText(id)
    if (!text) throw new Error(`The frozen ${id} definition is missing`)
    writeFileSync(join(root, ".flywheel", "workflows", `${id}.yaml`), text.replaceAll("file: steps/", "file: briefs/"))
  }
  return root
}

/** Load the retained project through the same catalog as a source-run project. */
export function retainedDefinitions(projectRoot: string) {
  return createProjectDefinitionRegistry({
    ...testDirectories(projectRoot),
    bundles: installedDefinitionBundles(repoModules),
    personaToolEntries: installedPersonaToolEntries(),
  })
}
