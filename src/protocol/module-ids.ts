import { Schema } from "effect"

/** The optional-capability vocabulary (ARCH-STRUCTURE-010) and the pure set operations
 *  over it, and nothing else.
 *
 *  Module identity and module implementation are different things with
 *  different reach. An id is a name on the wire, in a config file, and in a
 *  persisted selection; an implementation is tools, providers, and the runtime
 *  graph behind them. Keeping the vocabulary here means a reader of the
 *  vocabulary reads only the vocabulary.
 *
 *  That reach is the reason this module exists. `runtime-protocol-schemas.ts`
 *  names module ids, and deriving the vocabulary from the registry made the
 *  wire schema's value-import closure the whole registry: 247 modules, down to
 *  the file tools and their Bun bindings. Sourcing it here makes that closure
 *  20 modules of pure schema, which is what the wire actually is. It is what
 *  lets a client that is not Bun, such as an editor extension host, hold the
 *  protocol types at all.
 *
 *  The list is stated rather than derived, so the registry and the wire could
 *  drift. They cannot drift silently: the registry in
 *  `orchestration/modules.ts` carries a bidirectional compile-time proof
 *  against this vocabulary, on that side of the boundary so this package never
 *  names an orchestration path. */
export const MODULE_IDS = [
  "ask-user",
  "background-commands",
  "bash",
  "bug-reports",
  "code-mode",
  "definition-overrides",
  "development",
  "discovery",
  "experiments",
  "file-tools",
  "learning",
  "mcp",
  "papercuts",
  "project-notifications",
  "provider-anthropic-api",
  "provider-chatgpt",
  "provider-claude-agent-sdk",
  "provider-deepseek",
  "provider-github-copilot",
  "provider-google-api",
  "provider-google-vertex",
  "provider-openai-api",
  "provider-opencode-go",
  "provider-openrouter",
  "provider-supergrok",
  "recall",
  "remote",
  "side-question",
  "skills",
  "subagents",
  "subscription-usage",
  "web",
  "web-chatgpt",
  "web-exa",
  "workflows",
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

export const ModuleIdSchema = Schema.Literals(MODULE_IDS)

export const EMPTY_MODULE_IDS: readonly ModuleId[] = Object.freeze([])

/** The members of `selected` that are module ids, in vocabulary order. */
export function canonicalModuleIds(selected: Iterable<string>): readonly ModuleId[] {
  const members = new Set(selected)
  return MODULE_IDS.filter((id) => members.has(id))
}

export function missingModuleIds<const Required extends string>(required: readonly Required[], selected: readonly ModuleId[]): readonly Required[] {
  const enabled = new Set<string>(selected)
  return required.filter((id, index) => required.indexOf(id) === index && !enabled.has(id))
}

/** Why work that needs these modules cannot run, and how a person turns them
 *  on. Every refusal and omission that a disabled module causes uses these
 *  words, so a person, or a model that relays the reason, meets the same
 *  instruction wherever a module is off. */
export function moduleDisabledReason(missing: readonly string[]): string {
  const [verb, pronoun] = missing.length === 1 ? ["is", "it"] : ["are", "them"]
  return `${missing.join(", ")} ${verb} turned off. Turn ${pronoun} on in Settings, or remove ${pronoun} from disabled_modules in flywheel.toml`
}

/** Converts an effective module selection to the canonical persisted opt-out list. */
export function persistedDisabledModuleIds(selected: readonly string[]): readonly ModuleId[] {
  const enabled = new Set(selected)
  return MODULE_IDS.filter((id) => !enabled.has(id))
}
