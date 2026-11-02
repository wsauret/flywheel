import { createRequire } from "node:module"

import { runningSourceSnapshot } from "../src/infra/cli-subprocess.js"
import type { SourceEntry } from "../src/infra/source-snapshot.js"
import { installModuleCatalog } from "../src/orchestration/module-catalog.js"

/** Runs the Flywheel CLI from the source tree this file belongs to: the
 *  snapshot of a checkout that the dev entry chose, or a checkout whose
 *  source could not be snapshotted. The dev entry (`scripts/dev.ts`) and
 *  every executor generation (`scripts/project-executor.ts`) call it, and a
 *  source run starts its guardian by running this file with the guardian's
 *  role. `entry` is how the dev entry chose this tree, which this tree's own
 *  copy of the snapshot module records and keeps for a service to report. A
 *  packaged build never reaches this file. */
export async function runSourceCli(entry?: SourceEntry): Promise<void> {
  // A process that runs from a snapshot holds it while it runs, so no sweep
  // removes it. The dev entry already holds the snapshot it chose.
  // A process of a live checkout loads nothing for it.
  if (entry !== undefined) (await import("../src/infra/source-snapshot.js")).adoptSourceEntry(entry)
  else if (runningSourceSnapshot() !== undefined) (await import("../src/infra/source-snapshot.js")).holdRunningSnapshot()
  // A source run composes the shipped catalog plus the development modules,
  // which join the half of the catalog that claims no credential provider.
  // The catalog is installed as a loader, resolved synchronously on the first
  // read, because the module graph it names is most of orchestration and a
  // launch that never composes must not load it. The install must precede
  // the CLI import: a composition that reads the catalog first locks it.
  const load = createRequire(import.meta.url)
  installModuleCatalog({
    otherModules: () => [
      ...load("../src/orchestration/modules.js").SHIPPED_OTHER_MODULES,
      ...load("../src/orchestration/development-modules.js").DEVELOPMENT_MODULES,
    ],
  })
  // The CLI runs on this thread: it is this process, so there is no
  // bootstrap child to own, forward signals to, or copy an exit status back
  // from. The browser export condition this process was started with is the
  // one SolidJS resolves under.
  const { runFlywheelCli } = await import("../src/cli/index.js")
  await runFlywheelCli()
}

if (import.meta.main) await runSourceCli()
