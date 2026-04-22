import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "launcher" })

const isDev = import.meta.url.includes('/src/')
log.debug("init", { isDev })
if (isDev) {
  log.debug("loading OpenTUI preload")
  await import("@opentui/solid/preload")
  log.debug("OpenTUI preload loaded")
}

await import("./text-wrap-resize-patch")
log.debug("framework patches applied")

// Dynamic import ensures the OpenTUI plugin is registered before any JSX is parsed.
export async function startTUI(options: import("./app").TUIOptions = {}) {
  log.debug("startTUI called")
  try {
    const app = await import("./app.js");
    log.debug("app module imported")
    const result = await app.startTUI(options);
    log.debug("app.startTUI returned")
    return result;
  } catch (err) {
    log.error("startTUI failed", { error: errorMessage(err) })
    throw err;
  }
}
