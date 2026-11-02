import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadPathWorkflow, sessionWorkflowsDir, type LaunchingSessionAuthority } from "../../../../src/orchestration/workflow-host/path-workflow.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { fixtureDefinitions } from "../../../helpers/project-definitions.js"

export const revision = fixtureDefinitions().captureRevision()

export function write(dir: string, name: string, content: string): string {
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

/** Each test file owns its cleanup hooks, even when Bun shares this module. */
export function pathWorkflowFixtures() {
  const temporary = temporaryDirectories()
  return {
    session() {
      // Launch paths use the real path, not the link in the macOS temporary root.
      const sessionDir = realpathSync(temporary("flywheel-path-workflow-"))
      const dir = sessionWorkflowsDir(sessionDir)
      mkdirSync(dir, { recursive: true })
      return { sessionDir, dir }
    },
    async refusal(input: { readonly path: string; readonly sessionDir: string; readonly authority?: LaunchingSessionAuthority }) {
      const result = await loadPathWorkflow({ revision, authority: input.authority ?? fullAuthority(), ...input })
      if (result.ok) throw new Error(`expected ${input.path} to be refused`)
      return result
    },
  }
}
