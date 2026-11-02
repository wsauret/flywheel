import { describe, expect, test } from "bun:test"
import type { OwnedCommandRunner } from "../../../../src/infra/owned-command.js"
import { createGitAiAttributionService } from "../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js"
import { createGitAiAttributionProjection } from "../../../../src/orchestration/app-service/git-ai-attribution-projection.js"

const result = { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" } as const

describe("git AI attribution projection", () => {
  test("publishes availability on its own workspace cursor", async () => {
    const patches: unknown[] = []
    const run: OwnedCommandRunner = async () => result
    const service = createGitAiAttributionService({ canonicalRepositoryRoot: "/repo", runOwnedCommand: run, resolveExecutable: () => "git-ai" })
    const projection = createGitAiAttributionProjection({ service, publish: (patch) => patches.push(patch) })

    expect(projection.view()).toEqual({ kind: "checking" })
    await projection.check()
    expect(patches).toEqual([
      { cursor: { scope: "workspace", domain: "gitAiAttribution" }, payload: { kind: "gitAiAttribution.changed", status: { kind: "available" } } },
    ])
    projection.dispose()
    await service.dispose()
  })

  test("publishes an explicit unavailable status outside a repository", async () => {
    const patches: unknown[] = []
    const projection = createGitAiAttributionProjection({ publish: (patch) => patches.push(patch) })

    expect(projection.view()).toEqual({ kind: "unavailable", reason: "no-repository" })
    await expect(projection.check()).resolves.toEqual({ kind: "unavailable", reason: "no-repository" })
    expect(patches).toEqual([])
    projection.dispose()
  })
})
