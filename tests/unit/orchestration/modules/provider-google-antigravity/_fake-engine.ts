import type { EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-process.js"
import type { EnginePlace, RegisteredEngine } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-registry.js"
import type { McpToolDeclaration } from "../../../../../src/orchestration/modules/provider-google-antigravity/tool-projection.js"

/** A fake engine process for the registry and the demand: a test opens and settles its prompts, and ends it. */
export interface FakeEngine extends RegisteredEngine {
  readonly place: EnginePlace
  readonly closes: string[]
  openPrompt(): () => void
  end(served?: boolean): void
  readonly exited: boolean
}

export const tool = (name: string): McpToolDeclaration => ({ name, description: name, inputSchema: { type: "object" } })

/** A launch that makes one fake engine per call, numbered from 1, and records each, with a log of starts and ends.
 *  With `exitOnClose: false`, a closed engine exits only when the test calls its `end`. `holdNextLaunch` makes the next
 *  launch wait until the returned function runs. */
export function fakeLaunches(options: { readonly exitOnClose?: boolean } = {}) {
  const engines: FakeEngine[] = []
  const events: string[] = []
  let failNext: Error | undefined
  let held: Promise<void> | undefined
  const launch = async (place: EnginePlace): Promise<FakeEngine> => {
    const gate = held
    held = undefined
    await (gate ?? Promise.resolve())
    if (failNext !== undefined) {
      const failure = failNext
      failNext = undefined
      throw failure
    }
    const processId = `p${String(engines.length + 1)}`
    let open = 0
    let idle: (() => void)[] = []
    let served = false
    const ended = Promise.withResolvers<Awaited<EngineProcess["ended"]>>()
    let exited = false
    const end = (reason: string) => {
      if (exited) return
      exited = true
      events.push(`end ${processId}`)
      ended.resolve({ reason, served })
    }
    const engine: FakeEngine = {
      processId,
      place,
      closes: [],
      toolNames: new Set(place.tools.map(({ name }) => name)),
      get served() { return served },
      ended: ended.promise,
      get exited() { return exited },
      whenIdle: () => open === 0 ? Promise.resolve() : new Promise((resolve) => { idle.push(resolve) }),
      close(reason) {
        engine.closes.push(reason)
        if (options.exitOnClose !== false) end(reason)
        return ended.promise
      },
      openPrompt() {
        open += 1
        return () => {
          open -= 1
          served = true
          if (open > 0) return
          const waiting = idle
          idle = []
          for (const resolve of waiting) resolve()
        }
      },
      end(servedEnd = false) {
        served ||= servedEnd
        end("exited")
      },
    }
    engines.push(engine)
    events.push(`start ${processId} ${place.tools.map(({ name }) => name).join(",")}`)
    return engine
  }
  const holdNextLaunch = () => {
    const gate = Promise.withResolvers<void>()
    held = gate.promise
    return gate.resolve
  }
  return { launch, engines, events, failNextLaunch: (error: Error) => { failNext = error }, holdNextLaunch }
}

/** Lets every queued promise callback run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}
