import { join } from "node:path"
import type { OnLoadCallback, PluginBuilder, PluginConstraints } from "bun"

import { runningSourceSnapshot, sourceSnapshotHome } from "../infra/cli-subprocess.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { startupTrace } from "../infra/startup-trace.js"
import { keepingStackTraceSettings } from "./solid-transform-stack-trace.js"
import type { TUIOptions } from "./app.js"

const log = Log.create({ service: "launcher" })

const isDev = import.meta.url.includes('/src/')
startupTrace("tui launcher module start")
log.debug("init", { isDev })

/** A first-party JSX path that, of the OpenTUI plugin's load handlers, only
 *  its handler for first-party JSX matches. */
const FIRST_PARTY_JSX = "/source/view.tsx"

/** Every JSX file under `root`, as a Bun load filter. */
function jsxUnder(root: string): RegExp {
  return new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\].*\\.[cm]?[jt]sx(?:[?#].*)?$`)
}

/** Compiles the Solid JSX of the source tree this process runs, as
 *  `@opentui/solid/preload` does, with each load handler kept from changing
 *  the process's stack trace settings (`keepingStackTraceSettings`). The
 *  OpenTUI plugin compiles each JSX file outside a `node_modules` directory.
 *  A terminal of the dev entry runs from a snapshot in its checkout's build
 *  cache (ARCH-DISTRIBUTION-030), which sits under `node_modules`, so the
 *  plugin's handler for first-party JSX is also registered for the JSX of
 *  that snapshot. */
async function installSolidTransform(): Promise<void> {
  const { createSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  const snapshot = runningSourceSnapshot()
  const snapshotJsx = snapshot === undefined ? undefined : jsxUnder(join(sourceSnapshotHome(snapshot.checkout), snapshot.digest))
  Bun.plugin({
    name: "flywheel-solid",
    setup(build) {
      const keeping: PluginBuilder = Object.assign(Object.create(build), {
        onLoad: (constraints: PluginConstraints, load: OnLoadCallback) => {
          const kept = keepingStackTraceSettings(load)
          build.onLoad(constraints, kept)
          if (snapshotJsx !== undefined && constraints.filter.test(FIRST_PARTY_JSX)) build.onLoad({ filter: snapshotJsx }, kept)
          return keeping
        },
      })
      void createSolidTransformPlugin().setup(keeping)
    },
  })
}

// Dynamic import ensures the OpenTUI plugin is registered before any JSX is parsed.
export async function startTUI(options: TUIOptions) {
  let endImports: ReturnType<NonNullable<TUIOptions["timeline"]>["begin"]> | undefined
  startupTrace("startTUI entered")
  log.debug("startTUI called")
  try {
    // Register the preload before the app module's JSX is parsed.
    if (isDev) {
      log.debug("loading OpenTUI preload")
      await installSolidTransform()
      log.debug("OpenTUI preload loaded")
    }
    endImports = options.timeline?.begin("client.app_import")
    // Evaluate OpenTUI core by itself before the app graph. When the app
    // graph evaluates it, the app import takes about 12 ms longer and the
    // first frame comes that much later (startup perf gate, OpenTUI 0.6.8).
    // Chunk layout and top-level await were measured and are not the cause.
    await import("@opentui/core")
    const app = await import("./app.js");
    endImports?.()
    startupTrace("tui app module imported")
    log.debug("app module imported")
    const result = await app.startTUI(options);
    log.debug("app.startTUI returned")
    return result;
  } catch (err) {
    endImports?.("failed")
    options.timeline?.finish("failed", err)
    log.error("startTUI failed", { error: errorMessage(err) })
    throw err;
  }
}
