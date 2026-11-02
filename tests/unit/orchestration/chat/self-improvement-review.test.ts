import { expect, it } from "bun:test"

it("runs self-improvement reviews through an isolated runner host", async () => {
  const source = await Bun.file("src/orchestration/chat/runner-lifecycle.ts").text()
  expect(source).toContain("createAgentHost")
  expect(source).not.toContain("const runner = createRunnerContext({\n      createRunner: deps.createAgent,\n      agentRegistry: personas,")
})
