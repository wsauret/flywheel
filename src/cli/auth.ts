import type { ProjectDirectories } from "../infra/directory-authorities.js"
import type { AuthProfileAccess } from "../infra/auth/auth-profile-store.js"
import type { KeyResolver } from "../infra/auth/resolve-key.js"
import type { ExternalUrlOpener } from "../infra/open-external-url.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import type { CredentialProviderId } from "../infra/auth/auth-store-types.js"
import type { CredentialProviderCli } from "../infra/llm/access-provider.js"
import { errorMessage } from "../infra/error-message.js"
import { keptFreePlanMessage } from "../protocol/client/auth-login.js"
import {
  type AuthCatalogSettlement,
  credentialProviderDisplayName,
  getAuthStatus,
  getAuthStatusWithDiagnostics,
  loginWithApiKey,
  logoutProvider,
  providerLoginFlow,
} from "../orchestration/auth/auth-actions.js"
import { AuthProfileManager, type AuthProfileResolution } from "../orchestration/auth/auth-profile-manager.js"
import { accessProviderRegistry } from "../orchestration/agent-runtime/llm/access-provider-registry.js"
import { webAuthProviderDefinitions, type FirstPartyModuleComposition } from "../orchestration/modules.js"
import { createRuntimeConfigOwner } from "../orchestration/config/runtime-config-owner.js"
import { publishCustomProvidersFromConfig } from "../orchestration/config/custom-providers.js"
import { PromptCancelled, promptCancelledExitCode, type ReadlinePrompt } from "./readline-prompt.js"

export interface AuthOperations {
  readonly credentialProviderDisplayName: typeof credentialProviderDisplayName
  readonly getAuthStatus: typeof getAuthStatus
  readonly getAuthStatusWithDiagnostics: typeof getAuthStatusWithDiagnostics
  readonly loginWithApiKey: typeof loginWithApiKey
  readonly logoutProvider: typeof logoutProvider
  readonly providerLoginFlow: typeof providerLoginFlow
}

export interface AuthCommandDependencies {
  readonly actions: AuthOperations
  /** The module catalog this invocation composes, read after the config's
   *  [custom_providers] entries have joined it. */
  readonly composition: (moduleIds: readonly string[]) => FirstPartyModuleComposition
  readonly prompt: ReadlinePrompt
  readonly resolveKey: KeyResolver
  readonly openBrowser: ExternalUrlOpener
  /** Runs the program that owns an external login. */
  readonly launcher: LauncherScope
  readonly log: (...values: unknown[]) => void
  readonly error: (...values: unknown[]) => void
  readonly exit: (code: number) => never
  readonly settleCatalog: AuthCatalogSettlement
}

export const AUTH_OPERATIONS: AuthOperations = {
  credentialProviderDisplayName,
  getAuthStatus,
  getAuthStatusWithDiagnostics,
  loginWithApiKey,
  logoutProvider,
  providerLoginFlow,
}

interface CredentialProvider {
  readonly id: CredentialProviderId
  readonly cli: CredentialProviderCli
  /** The picker and usage text: the provider's name and how a person signs in. */
  readonly label: string
  /** Declared under [custom_providers] in flywheel.toml. */
  readonly custom: boolean
}

/** Every credential provider the composed catalog names: built-in model
 *  providers in status order, web providers after them, then the config's
 *  custom providers by name. The flag table, the picker, and the usage text
 *  are all this one list. */
function credentialProviders(composition: FirstPartyModuleComposition, customIds: ReadonlySet<string>): readonly CredentialProvider[] {
  const describe = (id: CredentialProviderId, cli: CredentialProviderCli, method: string): CredentialProvider =>
    ({ id, cli, label: `${cli.name} (${method})`, custom: customIds.has(id) })
  const access = accessProviderRegistry(composition).selection.definitions
    .toSorted((left, right) => left.auth.statusRank - right.auth.statusRank || left.displayName.localeCompare(right.displayName))
    .map(({ id, cli, auth }) => describe(id, cli, auth.kind === "api_key" ? "API key" : auth.kind === "external" ? "external login" : auth.flow === "browser" ? "browser OAuth" : "device code"))
  const web = webAuthProviderDefinitions(composition).map(({ id, cli }) => describe(id, cli, "API key"))
  return [...access.filter((provider) => !provider.custom), ...web, ...access.filter((provider) => provider.custom).toSorted((left, right) => left.cli.name.localeCompare(right.cli.name))]
}

const COMMAND_COLUMN = 24
const CUSTOM_PROVIDERS_HEADING = "Custom providers (flywheel.toml):"

function usage(providers: readonly CredentialProvider[]): string {
  const line = (command: string, description: string) => `  ${command.padEnd(COMMAND_COLUMN)} ${description}`
  const flagged = providers.filter((provider): provider is CredentialProvider & { readonly cli: { readonly flag: string } } => provider.cli.flag !== undefined)
  return [
    "Usage: flywheel auth <command>",
    "",
    "Commands:",
    line("login", "Select a provider to authenticate"),
    ...flagged.map((provider) => line(`login --${provider.cli.flag}`, `Authenticate with ${provider.label}`)),
    line("login --provider <id>", "Authenticate with a [custom_providers] entry (API key)"),
    line("status", "Show authentication status for all providers"),
    line("logout", "Select a provider to remove credentials"),
    ...flagged.map((provider) => line(`logout --${provider.cli.flag}`, `Remove ${provider.label} credentials`)),
    line("logout --provider <id>", "Remove a [custom_providers] entry's credentials"),
  ].join("\n")
}

/** Reads the provider a login or logout names. An option the command does
 *  not know, a second provider, or a built-in provider passed to --provider
 *  is refused, so a mistyped command never runs as another one. */
function flaggedProvider(command: string, args: readonly string[], providers: readonly CredentialProvider[], deps: AuthCommandDependencies): CredentialProviderId | undefined {
  const refuse = (message: string): never => {
    deps.error(message)
    return deps.exit(1)
  }
  const named: CredentialProviderId[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--provider") {
      const id = args[index + 1]
      index += 1
      if (!id) refuse("--provider requires a provider id declared under [custom_providers] in flywheel.toml.")
      const provider = providers.find((candidate) => candidate.id === id) ?? providers.find((candidate) => !candidate.custom && candidate.cli.flag === id)
      if (provider === undefined) refuse(`Unknown custom provider "${id}". Declare [custom_providers.${id}] in flywheel.toml first.`)
      else if (!provider.custom && provider.cli.flag !== undefined) refuse(`"${id}" is a built-in provider. Run flywheel auth ${command} --${provider.cli.flag}.`)
      else named.push(provider.id)
      continue
    }
    const provider = arg.startsWith("--") ? providers.find((candidate) => candidate.cli.flag !== undefined && arg === `--${candidate.cli.flag}`) : undefined
    if (provider === undefined) refuse(`Unknown option for flywheel auth ${command}: ${arg}\n\n${usage(providers)}`)
    else named.push(provider.id)
  }
  if (named.length > 1) refuse(`Name one provider for flywheel auth ${command}.`)
  return named[0]
}

export async function runAuth(args: string[], directories: ProjectDirectories, deps: AuthCommandDependencies): Promise<void> {
  const command = args[0]
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, watch: false })
  try {
    const config = runtimeConfig.snapshot().config
    const custom = publishCustomProvidersFromConfig(config.custom_providers)
    const providers = credentialProviders(deps.composition(config.modules), new Set(custom.slice.definitions.map(({ id }) => id)))
    if (!command) { deps.log(usage(providers)); return }
    const manager = new AuthProfileManager({ ...directories, config: () => config })
    const profile = await manager.resolve()
    if (profile.source === "environment" && !profile.availableProfiles.some(({ id }) => id === profile.id)) {
      deps.error(`FLYWHEEL_AUTH_PROFILE names the auth profile "${profile.id}", which does not exist. Available profiles: ${profile.availableProfiles.map(({ displayName }) => displayName).join(", ") || "none"}.`)
      deps.exit(1)
    }
    switch (command) {
      case "login": {
        const providerId = flaggedProvider(command, args.slice(1), providers, deps)
        const access = await manager.acquireAccess({ createDefault: true })
        try { await login(providerId, providers, profile, access, deps) } finally { access.close() }
        break
      }
      case "status":
        if (args.length > 1) { deps.error(`Unknown option for flywheel auth status: ${args[1]}`); deps.exit(1) }
        status(profile, deps)
        break
      case "logout": {
        const providerId = flaggedProvider(command, args.slice(1), providers, deps) ?? await selectProvider("log out of", providers, deps)
        let access: AuthProfileAccess
        try { access = await manager.acquireAccess() } catch (error) {
          if (profile.source !== "default" || profile.id !== "default") throw error
          deps.log(`No stored credentials for ${deps.actions.credentialProviderDisplayName(providerId)}.`)
          break
        }
        try { await logout(providerId, profile.directory, access, deps) } finally { access.close() }
        break
      }
      default: deps.error(`Unknown auth command: ${command}\n\n${usage(providers)}`); deps.exit(1)
    }
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error
    deps.error("Cancelled. Nothing was changed.")
    deps.exit(promptCancelledExitCode(error))
  } finally {
    await runtimeConfig.dispose()
  }
}

/** Asks for one provider by number, asking again after an answer that names
 *  none. An empty answer or q rejects with `PromptCancelled`. */
async function selectProvider(verb: string, providers: readonly CredentialProvider[], deps: AuthCommandDependencies): Promise<CredentialProviderId> {
  deps.log(`Select a provider to ${verb}:\n`)
  for (const [index, provider] of providers.entries()) {
    if (provider.custom && !providers[index - 1]?.custom) deps.log(`\n${CUSTOM_PROVIDERS_HEADING}`)
    deps.log(`  ${index + 1}) ${provider.label}`)
  }
  deps.log("")
  let question = "Enter number (or q to cancel): "
  while (true) {
    const answer = await deps.prompt(question)
    if (answer === "q" || answer === "") throw new PromptCancelled("no-answer")
    const selected = /^\d+$/.test(answer) ? providers[Number(answer) - 1] : undefined
    if (selected !== undefined) return selected.id
    question = `${answer} is not a choice. Enter a number from 1 to ${providers.length} (or q to cancel): `
  }
}

async function login(providerId: CredentialProviderId | undefined, providers: readonly CredentialProvider[], profile: Pick<AuthProfileResolution, "id" | "directory">, access: AuthProfileAccess, deps: AuthCommandDependencies): Promise<void> {
  const selectedId = providerId ?? await selectProvider("log in with", providers, deps)
  const selected = providers.find(({ id }) => id === selectedId)
  if (selected === undefined) throw new Error(`Unknown credential provider: ${selectedId}`)

  try {
    const flow = deps.actions.providerLoginFlow(selected.id)
    if (flow === undefined) await loginApiKey(selected, profile.directory, access, deps)
    else await loginOAuth(selected.id, flow, profile, access, deps)
  } catch (error) {
    if (error instanceof PromptCancelled) throw error
    // The reason is the one the terminal and the web show: a busy callback
    // port or a dropped connection is the person's to fix, not a rejection.
    deps.error(`Login failed: ${errorMessage(error)}`)
    deps.exit(1)
  }
}

async function loginApiKey(provider: CredentialProvider, credentials: string, access: AuthProfileAccess, deps: AuthCommandDependencies): Promise<void> {
  const key = await deps.prompt(`Enter the ${provider.cli.name} API key: `, { secret: true })
  if (!key) {
    deps.error("API key must not be empty.")
    deps.exit(1)
  }
  await deps.actions.loginWithApiKey(provider.id, key, credentials, deps.resolveKey, access, deps.settleCatalog)
  deps.log(`${provider.cli.name} API key stored.`)
}

/** Drives the flow the provider declared: a device code the user enters at
 *  the URL, or a browser handoff whose URL is printed for a headless box. */
async function loginOAuth(providerId: CredentialProviderId, flow: NonNullable<ReturnType<typeof providerLoginFlow>>, profile: Pick<AuthProfileResolution, "id" | "directory">, access: AuthProfileAccess, deps: AuthCommandDependencies): Promise<void> {
  const name = deps.actions.credentialProviderDisplayName(providerId)
  // The paste prompt of a browser flow reads the same input as the replace question, so it closes before that
  // question opens; otherwise both prompts share one line and one answer.
  const pastePrompt = new AbortController()
  let kept = false
  const ports = {
    authDir: profile.directory, profileId: profile.id, writeAccess: access, resolveKey: deps.resolveKey, openBrowser: deps.openBrowser, launcher: deps.launcher, settle: deps.settleCatalog,
    confirmReplace: async (question: string) => {
      pastePrompt.abort()
      const replace = /^y(es)?$/iu.test((await deps.prompt(`${question} Replace it? [y/N] `)).trim())
      kept = !replace
      return replace
    },
  }
  try {
    await runFlow()
  } catch (error) {
    if (!kept) throw error
    deps.log(keptFreePlanMessage(name))
    return
  } finally {
    pastePrompt.abort()
  }
  deps.log(`\nLogged in via ${name}.`)

  async function runFlow(): Promise<void> {
    if (flow.flow === "browser") {
      deps.log(`Opening browser for ${name} authentication...`)
      // A browser on another machine cannot reach this machine's callback, so the
      // page's code can be pasted instead. The prompt closes when the browser
      // finishes first. Ctrl+C at the prompt cancels the login and exits as an
      // interrupt; the end of input only stops offering the prompt, so a login
      // that the browser finishes still completes.
      const browserLogin = new AbortController()
      let interrupted: PromptCancelled | undefined
      try {
        await flow.login({
          ...ports,
          signal: browserLogin.signal,
          onAuthorizeUrl: ({ url }) => {
            deps.log("")
            deps.log("If a browser did not open, copy this URL:")
            deps.log(`  ${url}`)
            deps.log("")
            deps.log("Waiting for authorization...")
          },
          onManualCodeInput: () => deps.prompt("Paste the code that the page shows, or finish in the browser: ", { signal: AbortSignal.any([browserLogin.signal, pastePrompt.signal]) }).catch((error: unknown) => {
            if (error instanceof PromptCancelled && error.reason === "interrupt") {
              interrupted = error
              browserLogin.abort()
            }
            throw error
          }),
        })
      } catch (error) {
        throw interrupted ?? error
      } finally {
        browserLogin.abort()
      }
    } else {
      deps.log(`Starting ${name} device code flow...\n`)
      await flow.login({
        ...ports,
        onUserCode: ({ userCode, url }) => {
          deps.log("Open this URL:")
          deps.log(`  ${url}`)
          deps.log("")
          if (userCode !== undefined) {
            deps.log("Enter this code:")
            deps.log(`  ${userCode}`)
            deps.log("")
          }
          deps.log("Waiting for authorization...")
        },
        onProgress: (message) => deps.log(message),
      })
    }
  }
}

interface SourceLabelByStatus {
  [source: string]: string
}

const SOURCE_LABEL: SourceLabelByStatus = {
  stored_key: "stored",
  oauth: "active",
  invalid: "invalid credential",
  unconfigured: "not configured",
  misconfigured: "misconfigured",
}

function status(profile: AuthProfileResolution, deps: AuthCommandDependencies): void {
  deps.log(`Profile: ${profile.displayName} (${profile.source})`)
  const report = deps.actions.getAuthStatusWithDiagnostics(profile.directory)
  for (const diagnostic of report.diagnostics) deps.log(`Warning: ${diagnostic.message}`)
  for (const provider of report.providers) {
    const name = deps.actions.credentialProviderDisplayName(provider.providerId)
    const label = provider.expired ? "expired" : SOURCE_LABEL[provider.source] ?? provider.source
    deps.log(`${name}: ${label}${provider.detail === undefined ? "" : ` (${provider.detail})`}`)
  }
  if (report.providers.every((entry) => entry.source === "unconfigured")) deps.log(`Available profiles: ${profile.availableProfiles.length > 0 ? profile.availableProfiles.map((available) => available.displayName).join(", ") : "none"}`)
}

async function logout(providerId: CredentialProviderId, credentials: string, access: AuthProfileAccess, deps: AuthCommandDependencies): Promise<void> {
  const name = deps.actions.credentialProviderDisplayName(providerId)
  const before = deps.actions.getAuthStatus(credentials).find((entry) => entry.providerId === providerId)
  if (before?.source === "unconfigured" || !before) {
    deps.log(`No stored credentials for ${name}.`)
    return
  }
  await deps.actions.logoutProvider(providerId, credentials, deps.resolveKey, { writeAccess: access, launcher: deps.launcher })
  deps.log(`${name} credentials removed.`)
}
