import { describe, expect, test } from "bun:test"
import { sep } from "node:path"
import { Schema } from "effect"
import { RuntimeBackgroundRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"

describe("runtime server imports", () => {
  test("background RPCs route every request by canonical project root", async () => {
    const inputs = new Map<string, object>([
      ["RuntimeBackgroundRecall", { conversationId: "conversation", contract: { scope: "lineage" } }],
      ["RuntimeBackgroundTranscriptSearch", { request: { query: "needle", page: 1 } }],
      ["RuntimeBackgroundSessionChangeSummary", { sessionId: "session" }],
      ["RuntimeBackgroundSnapshot", {}],
      ["RuntimeBackgroundSessionSummaryImmediate", { sessionIds: ["session"] }],
      ["RuntimeBackgroundWaitForTotals", { sessionIds: ["session"] }],
      ["RuntimeBackgroundSessionDetail", { sessionId: "session" }],
      ["RuntimeBackgroundModuleSnapshot", { domain: "workflow_view", sessionId: "workflow" }],
      ["RuntimeBackgroundReleaseProject", {}],
    ])
    for (const [name, rpc] of RuntimeBackgroundRpc.requests) {
      if (name === "RuntimeBackgroundShutdown") continue
      const fields = inputs.get(name)
      expect(fields).toBeDefined()
      const decode = Schema.decodeUnknownSync(rpc.payloadSchema)
      expect(decode({ ...fields, projectRoot: "/workspace" })).toEqual({ ...fields, projectRoot: "/workspace" })
      expect(() => decode(fields)).toThrow()
      expect(() => decode({ ...fields, projectRoot: "" })).toThrow()
    }
  })

  test("server entry modules do not import TUI/OpenTUI/JSX surfaces directly", async () => {
    for (const file of ["src/orchestration/app-service/account-service-runtime.ts", "src/orchestration/app-service/project-execution-runtime.ts"]) {
      const source = await Bun.file(file).text()
      expect(source).not.toContain("@opentui")
      expect(source).not.toContain("/tui/")
      expect(source).not.toContain("@jsxImportSource")
    }
  })

  test("first-class runtime isolation uses Workers, with dedicated owned and persistent subprocess boundaries", async () => {
    for (const file of [
      "src/orchestration/app-service/account-service-runtime.ts",
      "src/orchestration/app-service/runtime-background-lane.ts",
    ]) {
      const source = await Bun.file(file).text()
      expect(source).not.toContain("Bun.spawn")
      expect(source).not.toContain("detached: true")
      expect(source).not.toContain(".unref()")
    }

    const detachedOwners: string[] = []
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx}").scan(".")) {
      // A scan yields host separators. The expectation below names repository
      // paths, which are written the one way on every platform.
      if ((await Bun.file(file).text()).includes("detached: true")) detachedOwners.push(file.replaceAll(sep, "/"))
    }
    // Detachment is an ownership decision. Only the owned-process backends and
    // the dedicated persistent-process boundary may request it.
    expect(detachedOwners.toSorted()).toEqual([
      "src/infra/owned-subprocess-backend.ts",
      "src/infra/persistent-subprocess.ts",
      "src/infra/process-supervisor.ts",
    ])
  })
})
