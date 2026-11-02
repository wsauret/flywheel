import { afterEach, describe, expect, test } from "bun:test"
import type { OnLoadArgs } from "bun"
import yaml from "js-yaml"

import { keepingStackTraceSettings } from "../../../src/tui/solid-transform-stack-trace.js"

const original = { prepareStackTrace: Error.prepareStackTrace, stackTraceLimit: Error.stackTraceLimit }

afterEach(() => {
  Error.prepareStackTrace = original.prepareStackTrace
  Error.stackTraceLimit = original.stackTraceLimit
})

/** What Babel does on its first compile, for the rest of the process: it
 *  raises the limit and passes every captured object to the formatter it
 *  found, which is Bun's native one. */
function babelFirstCompile(): void {
  const formatter = Error.prepareStackTrace
  Error.prepareStackTrace = (error, trace) => formatter?.(error, trace)
  Error.stackTraceLimit = 50
}

const args: OnLoadArgs = { path: "/source/view.tsx", namespace: "file", loader: "tsx", defer: async () => {} }

describe("keepingStackTraceSettings", () => {
  test("a compile leaves the stack trace settings as they were, so a library error that only inherits from Error keeps its type", async () => {
    await keepingStackTraceSettings(async () => {
      babelFirstCompile()
      return { contents: "", loader: "js" }
    })(args)

    expect({ prepareStackTrace: Error.prepareStackTrace, stackTraceLimit: Error.stackTraceLimit }).toEqual(original)
    expect(() => yaml.load("a: [")).toThrow(yaml.YAMLException)
  })

  test("a compile that starts while another is under way also leaves the settings as they were before both", async () => {
    const firstInstalled = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const releaseSecond = Promise.withResolvers<void>()
    const load = keepingStackTraceSettings(async (loadArgs) => {
      if (loadArgs.path === "/source/first.tsx") {
        babelFirstCompile()
        firstInstalled.resolve()
        await releaseFirst.promise
      } else {
        await releaseSecond.promise
      }
      return { contents: "", loader: "js" }
    })
    const first = load({ ...args, path: "/source/first.tsx" })
    await firstInstalled.promise
    const second = load({ ...args, path: "/source/second.tsx" })
    releaseFirst.resolve()
    await first
    releaseSecond.resolve()
    await second

    expect({ prepareStackTrace: Error.prepareStackTrace, stackTraceLimit: Error.stackTraceLimit }).toEqual(original)
    expect(() => yaml.load("a: [")).toThrow(yaml.YAMLException)
  })
})
