import type { OnLoadCallback } from "bun"

/** Wraps a load handler of the OpenTUI Solid transform so that the process keeps
 *  the stack trace settings it had when the handler was wrapped.
 *
 *  The transform compiles with Babel, and Babel's first compile changes those
 *  settings for the rest of the process: it raises `Error.stackTraceLimit`
 *  and replaces `Error.prepareStackTrace` with a wrapper that passes every
 *  captured object to Bun's own formatter. That formatter throws "First
 *  argument must be an Error object" for an object that only inherits from
 *  `Error.prototype`, such as a js-yaml `YAMLException`, so the error that
 *  such a library throws is replaced. The product runs prebuilt JSX and never
 *  runs Babel, so a source run and a test process must not keep the change.
 *
 *  The settings are read once, here, and not around each compile: compiles
 *  overlap, and one that starts while Babel's change is in place would put
 *  the change back when it ends. */
export function keepingStackTraceSettings(load: OnLoadCallback): OnLoadCallback {
  const { prepareStackTrace, stackTraceLimit } = Error
  return async (args) => {
    try {
      return await load(args)
    } finally {
      Error.prepareStackTrace = prepareStackTrace
      Error.stackTraceLimit = stackTraceLimit
    }
  }
}
