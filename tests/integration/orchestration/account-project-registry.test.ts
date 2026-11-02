import { expect, it } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { canonicalPathWithMissingTail } from "../../../src/infra/canonical-path"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry"
import { temporaryDirectories } from "../../helpers/directories"

const temporary = temporaryDirectories()

async function mutateRegistryInChild(userDataRoot: string, projectRoot: string, action: "record" | "forget"): Promise<void> {
  const moduleUrl = new URL("../../../src/orchestration/app-service/account-project-registry.ts", import.meta.url).href
  const operation = action === "record"
    ? `await registry.record({ projectRoot: ${JSON.stringify(projectRoot)}, label: "Child" })`
    : `await registry.forget(${JSON.stringify(projectRoot)})`
  const child = Bun.spawn([process.execPath, "-e", `
    const { createAccountProjectRegistry } = await import(${JSON.stringify(moduleUrl)});
    const registry = createAccountProjectRegistry({ userDataRoot: ${JSON.stringify(userDataRoot)} });
    ${operation};
    await registry.dispose();
  `], { windowsHide: true, stdout: "inherit", stderr: "inherit" })
  expect(await child.exited).toBe(0)
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Account registry watcher did not observe the separate-process commit")
}

it("watches separate-process record and forget commits", async () => {
  const root = temporary("flywheel-account-projects-")
  const userDataRoot = join(root, "account")
  const firstProject = join(root, "first")
  mkdirSync(firstProject)
  const projects = createAccountProjectRegistry({ userDataRoot })
  try {
    const observed: string[][] = []
    projects.watch((rows) => observed.push(rows.map((row) => row.projectRoot)))

    await mutateRegistryInChild(userDataRoot, firstProject, "record")
    const canonical = canonicalPathWithMissingTail(firstProject)
    await waitFor(() => observed.some((rows) => rows.includes(canonical)))

    await mutateRegistryInChild(userDataRoot, firstProject, "forget")
    await waitFor(() => observed.at(-1)?.length === 0)
  } finally {
    await projects.dispose()
  }
})
