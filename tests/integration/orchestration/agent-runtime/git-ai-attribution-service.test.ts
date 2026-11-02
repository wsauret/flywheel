import { describe, expect, test } from "bun:test"

import { lingerAfter, sourceModule } from "../../../helpers/process-linger.js"

describe("git-ai attribution service", () => {
  // A project executor disposes this service in its stop and then ends by
  // returning, so a dispose that leaves its 500 ms drain bound armed can hold
  // the executor open after its stop.
  test("disposing holds its process open no longer than the dispose", async () => {
    const setup = [
      `import { createGitAiAttributionService } from ${JSON.stringify(sourceModule("orchestration/agent-runtime/git-ai-attribution-service.ts"))}`,
      `const service = createGitAiAttributionService({ canonicalRepositoryRoot: "/scratch/repository", runOwnedCommand: async () => { throw new Error("no command runs") }, resolveExecutable: () => null })`,
    ].join("\n")

    const { lingerMs } = await lingerAfter(setup, "service.dispose()")

    expect(lingerMs).toBeLessThan(250)
  })
})
