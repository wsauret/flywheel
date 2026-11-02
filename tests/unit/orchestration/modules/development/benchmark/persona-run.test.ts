import { expect, it } from "bun:test"

it("runs persona benchmark cells through the shared runner host", async () => {
  const source = await Bun.file("src/orchestration/modules/development/benchmark/persona-run.ts").text()
  expect(source).toContain("invokeBenchmarkAgent")
  expect(source).not.toContain("deps.createAgent({")
})
