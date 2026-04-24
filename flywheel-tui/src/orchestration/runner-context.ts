import type { Engine, EngineResult, RunnerOptions } from "./engines/core/types.js"
import type { UserEventToolResult } from "../infra/ndjson-event-types.js"

const EMPTY_DRAIN_RESULT: string[] = Object.freeze([]) as unknown as string[]

/**
 * Thin wrapper around an `EngineRunner` that hides the raw runner reference
 * so each call site compares context identity, not runner identity — the
 * protective semantic against stale async completions that motivated the
 * guard. Completion is surfaced only through the `done` promise; callers
 * `await` (worker-callback) or `.then/.catch` (chat-session) directly.
 */
export interface RunnerContextOptions extends RunnerOptions {
  engine: Engine
}

export interface RunnerContext {
  send(text: string): void
  abort(): void
  end(): void
  /** Returns `[]` when the underlying runner omits the optional method. */
  drainPendingInputs(): string[]
  /** Present when the underlying runner implements `sendToolResult`. */
  sendToolResult?(toolResult: UserEventToolResult): void
  /** Resolves with the engine's final result — never rejects for harness runners;
   *  subprocess engines may reject if the process dies before producing a result. */
  readonly done: Promise<EngineResult>
}

export function createRunnerContext(opts: RunnerContextOptions): RunnerContext {
  const { engine, ...runnerOptions } = opts
  const runner = engine.createRunner(runnerOptions)

  const ctx: RunnerContext = {
    send(text: string) { runner.send(text) },
    abort() { runner.abort() },
    end() { runner.end() },
    drainPendingInputs() {
      return runner.drainPendingInputs ? runner.drainPendingInputs() : EMPTY_DRAIN_RESULT
    },
    done: runner.done,
  }

  if (runner.sendToolResult) {
    ctx.sendToolResult = (toolResult) => { runner.sendToolResult!(toolResult) }
  }

  return ctx
}