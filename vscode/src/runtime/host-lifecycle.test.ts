import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Redacted } from "effect"

import { establishRuntime, type EstablishDeps, type HostPhase } from "./host-lifecycle.js"
import type { ResolvedRuntime } from "./runtime-resolver.js"

const INSTALLED: ResolvedRuntime = { executable: "/installed/flywheel", version: "0.0.12", source: "launcher" }
const LISTENING = {
  ok: true,
  target: { socketPath: "/account/serve.sock", projectRoot: "/project", credential: Redacted.make("token") },
  service: { pid: 7, lane: "installed", version: "0.0.12", protocolVersion: 12 },
} as const

function deps(overrides: Partial<EstablishDeps>): EstablishDeps {
  return {
    projectRoot: () => "/project",
    resolve: async () => ({ ok: true, runtime: INSTALLED }),
    install: async () => { throw new Error("nothing installs when Flywheel is found") },
    start: async () => LISTENING,
    now: () => 1_000,
    ...overrides,
  }
}

async function phases(overrides: Partial<EstablishDeps>): Promise<HostPhase[]> {
  const seen: HostPhase[] = []
  await establishRuntime(deps(overrides), (phase) => { seen.push(phase) })
  return seen
}

describe("the editor's way to a runtime", () => {
  test("reports each step of the start and ends ready with what the host connects to", async () => {
    const seen = await phases({
      start: async (_runtime, _root, onStep) => {
        onStep("Starting account service")
        return LISTENING
      },
    })
    assert.deepEqual(seen.map((phase) => phase.kind === "starting" ? `starting:${phase.label ?? ""}` : phase.kind), ["starting:", "starting:Starting account service", "ready"])
    // Every step of one start counts its wait from the same moment, so the
    // page's "still starting" notice does not begin again at each step.
    assert.deepEqual(seen.flatMap((phase) => phase.kind === "starting" ? [phase.since] : []), [1_000, 1_000])
  })

  test("installs Flywheel where none is found and starts the one it installed", async () => {
    const started: string[] = []
    const seen = await phases({
      resolve: async () => ({ ok: false, failure: { kind: "none_found" } }),
      install: async () => ({ ok: true, runtime: INSTALLED }),
      start: async (runtime) => {
        started.push(runtime.executable)
        return LISTENING
      },
    })
    assert.deepEqual(seen.map((phase) => phase.kind), ["starting", "installing", "starting", "ready"])
    assert.deepEqual(started, ["/installed/flywheel"])
  })

  test("ends unavailable with the cause and starts nothing after a failure", async () => {
    let starts = 0
    const failed = await phases({
      resolve: async () => ({ ok: false, failure: { kind: "none_found" } }),
      install: async () => ({ ok: false, failure: { kind: "fetch_failed", url: "https://install", detail: "offline" } }),
      start: async () => {
        starts++
        return LISTENING
      },
    })
    assert.deepEqual(failed.at(-1), { kind: "unavailable", failure: { kind: "install", failure: { kind: "fetch_failed", url: "https://install", detail: "offline" } } })
    assert.equal(starts, 0)
  })

  test("asks for a folder before it looks for Flywheel", async () => {
    let resolved = 0
    const seen = await phases({
      projectRoot: () => undefined,
      resolve: async () => {
        resolved++
        return { ok: true, runtime: INSTALLED }
      },
    })
    assert.deepEqual(seen, [{ kind: "unavailable", failure: { kind: "no_folder" } }])
    assert.equal(resolved, 0)
  })
})
