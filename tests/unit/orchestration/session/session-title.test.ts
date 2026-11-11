import { expect, it } from "bun:test"
import { generateSessionTitle, type SessionTitles } from "../../../../src/orchestration/session/session-title.js"
import { resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { testAuth as auth, titleRoots } from "../../../fixtures/session-title-fixtures.js"
import { asModelClient } from "../agent-runtime/_model-client.js"

it("resolves title requests again when the catalog changes during a validation retry", async () => {
  let models = ["gpt-6-luna"]
  const requested: { model: string; effort: string | undefined }[] = []
  const title = Promise.withResolvers<SessionTitles>()
  const generation = generateSessionTitle("name this session", (value) => {
    if (requested.length === 2) title.resolve(value)
  }, {
    auth, ...titleRoots, model: "gpt-6-luna",
    resolveRoles: (capture) => resolveSessionRoles({ defaults: {}, overrides: {} }, capture ?? roleCapture(models), titleRoots.userDataRoot),
    createRunner: (options) => newTestRunner(options, async (model) => asModelClient({
      model, modelFamily: model.startsWith("claude") ? "anthropic" : "openai", accessProvider: "openai_api",
      contextLimit: 200_000, outputLimit: 8_000, supportsReasoning: true,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(input) {
        requested.push({ model, effort: input.reasoningEffort })
        models = ["claude-haiku-5.5"]
        yield { kind: "text_delta", blockKey: "text", text: requested.length === 1 ? "invalid" : "TITLE: Resolved title\nSHORT: Resolved" }
        yield { kind: "done", stopReason: "end_turn" }
      },
    })),
  })
  try {
    expect(await title.promise).toEqual({ full: "Resolved title", short: "Resolved" })
    expect(requested).toEqual([{ model: "gpt-6-luna", effort: "low" }, { model: "claude-haiku-5.5", effort: "low" }])
  } finally { generation.abort() }
})
