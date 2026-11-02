import { isAbsolute } from "node:path"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import type { KeyResolver } from "../infra/auth/resolve-key.js"
import { writeHeadlessAuthSnapshot } from "../orchestration/headless/benchmark-auth-file.js"
import type { AccessProviderDefinition } from "../infra/llm/access-provider.js"

const USAGE = "Usage: flywheel headless snapshot-auth --auth-profile <id-or-unique-display-name> --output </private/flywheel-auth-bundle-*/auth.json>\nThe snapshot contains raw credentials and is only for a trusted target."

/** Exports one resolved auth profile for transfer to a headless runtime. */
export async function runHeadlessSnapshotAuth(args: readonly string[], directories: StartupDirectories, resolveKey: KeyResolver, providers: readonly AccessProviderDefinition[]): Promise<void> {
  const selector = readRequired(args, "--auth-profile")
  const output = readRequired(args, "--output")
  if (args.length !== 4 || !selector || !output || !isAbsolute(output)) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const profile = await writeHeadlessAuthSnapshot({
    userDataRoot: directories.userDataRoot,
    projectRoot: directories.projectRoot,
    selector,
    output,
    resolveKey,
    providers,
  })
  process.stdout.write(`${profile}\n`)
}

function readRequired(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  const value = index === -1 ? undefined : args[index + 1]
  return value && !value.startsWith("--") ? value : undefined
}
