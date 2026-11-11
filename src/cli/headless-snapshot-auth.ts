import { isAbsolute } from "node:path"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import type { KeyResolver } from "../infra/auth/resolve-key.js"
import { writeHeadlessAuthSnapshot } from "../orchestration/headless/benchmark-auth-file.js"
import type { AccessProviderDefinition } from "../infra/llm/access-provider.js"
import { isAuthProfileName } from "../infra/paths.js"
import { accessProviderRegistry } from "../orchestration/agent-runtime/llm/access-provider-registry.js"
import { publishCustomProvidersFromConfig } from "../orchestration/config/custom-providers.js"
import { createRuntimeConfigOwner } from "../orchestration/config/runtime-config-owner.js"
import { composeFirstPartyModules } from "../orchestration/modules.js"

const USAGE = "Usage: flywheel headless snapshot-auth --auth-profile <id-or-unique-display-name> --output </private/flywheel-auth-bundle-*/auth.json> [--provider <id>]... [--min-valid-seconds <n>] [--as-profile <id>]\n" +
  "  --provider           Export only this credential provider's credentials, such as chatgpt. Repeat it to keep more providers.\n" +
  "                       A provider that takes a login token reads it from the environment variable that the provider names.\n" +
  "                       Give several tokens, one per line, to make each its own account; a run moves to the next at a usage limit.\n" +
  "  --min-valid-seconds  Refresh on this host each access token that expires sooner, and refuse when that is not possible.\n" +
  "  --as-profile         Name the snapshot's profile <id> instead of the exported profile's ID.\n" +
  "The snapshot contains raw access tokens and is only for a trusted target. It prints the profile ID that a run selects."

const FLAGS = new Set(["--auth-profile", "--output", "--min-valid-seconds", "--as-profile", "--provider"])
const REPEATABLE_FLAGS = new Set(["--provider"])

/** The providers whose credentials a snapshot can carry: the installed catalog and the [custom_providers] entries of
 *  the account config, which this publishes as a headless run does, so their credentials export like built-in ones. */
export async function snapshotAuthProviders(directories: StartupDirectories): Promise<readonly AccessProviderDefinition[]> {
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
  try {
    publishCustomProvidersFromConfig(runtimeConfig.snapshot().config.custom_providers)
  } finally {
    await runtimeConfig.dispose()
  }
  return accessProviderRegistry(composeFirstPartyModules()).selection.definitions
}

/** Exports one resolved auth profile for transfer to a headless runtime. */
export async function runHeadlessSnapshotAuth(args: readonly string[], directories: StartupDirectories, resolveKey: KeyResolver, providers: readonly AccessProviderDefinition[]): Promise<void> {
  const flags = readFlags(args)
  const selector = flags?.get("--auth-profile")?.[0]
  const output = flags?.get("--output")?.[0]
  const minValid = flags?.get("--min-valid-seconds")?.[0]
  const minValidSeconds = minValid === undefined ? undefined : Number(minValid)
  const asProfile = flags?.get("--as-profile")?.[0]
  const providerIds = flags?.get("--provider")
  if (!selector || !output || !isAbsolute(output) || (minValidSeconds !== undefined && !(Number.isSafeInteger(minValidSeconds) && minValidSeconds > 0)) || (asProfile !== undefined && !isAuthProfileName(asProfile))) {
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
    ...(minValidSeconds === undefined ? {} : { minValidSeconds }),
    ...(asProfile === undefined ? {} : { asProfile }),
    ...(providerIds === undefined ? {} : { providerIds }),
    environment: process.env,
  })
  process.stdout.write(`${profile}\n`)
}

/** Reads `--flag value` pairs, or undefined for an unknown or valueless flag, or a repeated flag that is not repeatable. */
function readFlags(args: readonly string[]): ReadonlyMap<string, readonly string[]> | undefined {
  if (args.length % 2 !== 0) return undefined
  const flags = new Map<string, readonly string[]>()
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]]
    if (flag === undefined || value === undefined || !FLAGS.has(flag) || value.length === 0 || value.startsWith("--")) return undefined
    const values = flags.get(flag) ?? []
    if (values.length > 0 && !REPEATABLE_FLAGS.has(flag)) return undefined
    flags.set(flag, [...values, value])
  }
  return flags
}
