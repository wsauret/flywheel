import type { AgentDefinition } from "../../infra/agent-definition.js"
import { workflowAgentSubagents } from "../agents/subagent-reachability.js"
import { hashDefinition } from "../definition-hash.js"
import { composedIdentity, personaIdentitySha256, type DefinitionIdentity, type DefinitionIdentityOptions } from "./definition-identity.js"

// Proofs that a persona hash an earlier build recorded names the current bundled persona. Each proof restores
// exactly the text or keys a retired edit removed, so any other change to a persona still reports as drift.

/** The turn caps bundled personas carried while persona identity covered the
 *  turn cap: ship 40, the default 50, general 100, and implementer 150. */
const RETIRED_TURN_CAPS = [40, 50, 100, 150] as const

/** The recorded identity with each persona hash that covered a turn cap
 *  replaced by the current identity hash of that persona, when the recorded
 *  hash proves the persona differs from the current definition only by its
 *  turn cap: it equals the current definition, with or without its lexicon
 *  clauses restored, hashed with its own cap or with a cap a bundled persona
 *  carried. Any other hash stays, so a changed procedure still reports as
 *  drift. Returns the same identity when no hash changes. Remove after
 *  2027-04-13. */
export function withoutRecordedTurnCaps<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => {
    const caps = [...new Set([persona.maxTurns, ...RETIRED_TURN_CAPS])]
    return lexiconForms(persona).flatMap((form) => caps.map((maxTurns) => hashDefinition({ ...form, maxTurns }).sha256))
  })
}

/** Clauses of bundled personas that a later edit rewrote: each persona's current clause, paired with the exact
 *  text it replaced. A clause can sit in the description or in the system prompt. */
type RetiredPersonaText = ReadonlyMap<string, readonly (readonly [current: string, retired: string])[]>

/** Each persona clause that the workflow lexicon rewrote: the retired workflow words of explorer, reviewer-uat, and
 *  reviewer-plan-elegance, with phase as the part of a plan. Remove after 2027-04-30. */
const RETIRED_LEXICON_TEXT: RetiredPersonaText = new Map([
  ["explorer", [
    ["The brief selects one of two modes, targeted", "The dispatch brief selects one of two lanes, targeted"], // retired text
    [
      "You are a focused investigator working in one of two modes. The brief selects the mode: work in the targeted mode unless",
      "You are a focused investigator working one of two lanes. The dispatch brief selects the lane: work the targeted lane unless", // retired text
    ],
    ["## Targeted mode (default)", "## Targeted lane (default)"], // retired text
    ["## Enumerative mode (when", "## Enumerative lane (when"], // retired text
    ["In this mode a missed integration point", "In this lane a missed integration point"], // retired text
  ]],
  ["reviewer-uat", [["Long model responses or agents of a workflow do not justify", "Long model responses or workflow steps do not justify"]]], // retired text
  ["reviewer-plan-elegance", [["lens across milestones, ownership", "lens across phases, ownership"]]],
])

/** Each persona clause that replaced a tool-steering clause. */
const RETIRED_TOOL_STEERING: RetiredPersonaText = new Map([
  ["explorer", [[
    "- Use whichever tools fit: the file tools or read-only shell commands both work for discovery, search, and reading.\n- For GitHub repository data, use read-only `gh` commands through bash or exec for pull requests, commits, diffs, reviews, and issues. Use web only when `gh` is unavailable or cannot provide the required data.",
    "- Use your dedicated tools for all file operations. NEVER use shell execution for tasks a dedicated tool handles:\n  - File discovery: use list (NOT shell find/ls)\n  - Content search: use search (NOT shell grep/rg/ack)\n  - Reading files: use read (NOT shell cat/head/tail/less)\n  - GitHub repository data: use read-only `gh` commands through bash or exec (NOT web) for pull requests, commits, diffs, reviews, and issues. Use web only when `gh` is unavailable or cannot provide the required data.\n  - External pages: use web (NOT shell curl/wget)\n  - Shell execution (bash or exec) is ONLY for commands with no dedicated tool equivalent: git and gh inspection, wc, etc.",
  ]]],
  ["advisor", [[
    "materially affect your recommendation. Do not implement changes",
    "materially affect your recommendation. Use dedicated file tools instead of shell commands for file discovery, content search, and file reads. Do not implement changes",
  ]]],
])

/** Each reviewer-uat clause that replaced a clause of its ten-minute wall-clock budget, as the clause read before the
 *  workflow lexicon (refer to `lexiconForms`). */
const RETIRED_SCENARIO_BUDGET: RetiredPersonaText = new Map([
  ["reviewer-uat", [
    [
      "## The Live Scenario Budget\n\nAllow a live scenario to take as long as the product needs. There is no fixed wall-clock cap. Keep each drive command short, observe its result, then choose the next action. Long model responses or workflow steps do not justify a blind end-to-end script.", // retired text
      "## The 10-Minute Budget\n\nYou have a soft cap of **approximately ten minutes of wall-clock time**. This is not a turn budget; turns don't track wall-clock. A single `bash` call can run for hours. The constraint shapes *which* commands you choose, not just *how many*.",
    ],
    [
      "Bound each bash invocation with the tool's timeout parameter. Do not use the `timeout` shell utility. A single command must remain bounded:",
      "Bound every bash invocation with your bash tool's timeout parameter. Do NOT prefix commands with the `timeout` shell utility; it does not exist on macOS. A single command must not be able to consume the entire budget on its own:",
    ],
    [
      "If a scenario needs more than five minutes, split it into bounded actions and observations. Do not increase the per-command ceiling.",
      "If a command needs more than 5 minutes to produce evidence, you picked the wrong command. Pick a narrower one.",
    ],
    [
      "Choose the highest-leverage narrow checks first. Use the system's public `--help` and live-drive documentation to discover its surfaces.",
      "The activity ladder below is ordered so the highest-leverage narrow checks come first. Reaching rung 3 with decisive evidence in 7 minutes is the goal; reaching rung 5 in 25 minutes is failure.",
    ],
    [
      "- A P1 has been confirmed; one is enough. Do not pile on.\n\nIf an environment blocker prevents decisive evidence, report the partial evidence and the specific missing prerequisite. Product latency alone is not a blocker.",
      "- You are nearing the 10-minute budget (roughly: you've spent more than 7-8 minutes and have not yet started rung 4). Report what you confirmed; flag what you didn't reach.\n- A P1 has been confirmed; one is enough. Do not pile on.\n\nIf you cannot reach decisive evidence within the budget with surgical commands, **report partial evidence plus a note about what would require more time**. That's a valid outcome. A clear partial report beats running over budget chasing completeness.",
    ],
  ]],
])

/** The persona as it read before the `retiredText` clauses were rewritten, or undefined when it never carried any. */
function withRetiredText(persona: AgentDefinition, retiredText: RetiredPersonaText): AgentDefinition | undefined {
  const clauses = retiredText.get(persona.name)
  if (persona.kind !== "persona" || !clauses) return undefined
  const { description, systemPrompt } = persona
  if (!clauses.every(([current]) => description.includes(current) || systemPrompt.includes(current))) return undefined
  const restore = (text: string) => clauses.reduce((restored, [current, retired]) => restored.replace(current, retired), text)
  return { ...persona, description: restore(description), systemPrompt: restore(systemPrompt) }
}

/** The persona as it reads now and, when the workflow lexicon rewrote some of its clauses, as it read before. A build
 *  that recorded a hash before an older persona edit also predates the lexicon, so each older proof tries both forms.
 *  Remove after 2027-04-30. */
function lexiconForms(persona: AgentDefinition): readonly AgentDefinition[] {
  const retired = withRetiredText(persona, RETIRED_LEXICON_TEXT)
  return retired ? [persona, retired] : [persona]
}

/** Every hash a build could record for `form`: without a turn cap, or with the current persona's cap or a retired one. */
function budgetedHashes(form: AgentDefinition, currentMaxTurns: number | undefined): readonly string[] {
  const { maxTurns: _budget, ...procedure } = form
  return [hashDefinition(procedure).sha256, ...[currentMaxTurns, ...RETIRED_TURN_CAPS].map((maxTurns) => hashDefinition({ ...procedure, maxTurns }).sha256)]
}

/** The recorded identity with each persona hash that one of `hashes` produced replaced by the current identity hash
 *  of that persona. Returns the same identity when no hash changes. */
function adoptProvenPersonas<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
  hashes: (persona: AgentDefinition) => readonly string[],
): Identity {
  let changed = false
  const adopted = identity.personas.map((entry) => {
    const persona = personas.get(entry.personaName)
    if (!persona || entry.sha256 === null || !hashes(persona).includes(entry.sha256)) return entry
    changed = true
    return { ...entry, sha256: personaIdentitySha256(persona) }
  })
  return changed ? { ...identity, personas: adopted } : identity
}

/** The recorded identity with each persona hash that the retired tool-steering text produced replaced by the
 *  current identity hash of that persona. A recorded hash qualifies only when it equals the current definition
 *  with exactly those clauses restored, with or without its lexicon clauses restored, hashed without a turn cap or
 *  with its own or a retired one, so any other change still reports as drift. Returns the same identity when no hash
 *  changes. Remove after 2027-04-13. */
export function withoutRetiredToolSteering<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => lexiconForms(persona).flatMap((form) => {
    const retired = withRetiredText(form, RETIRED_TOOL_STEERING)
    return retired ? budgetedHashes(retired, persona.maxTurns) : []
  }))
}

interface RetiredPromptSwitches {
  readonly projectContext?: boolean
  readonly engineeringDoctrine?: boolean
}

/** Every value a persona file could give the retired prompt switches, each
 *  key absent, true, or false, except the shape that sets neither. */
const RETIRED_PROMPT_SWITCHES: readonly RetiredPromptSwitches[] = [undefined, true, false]
  .flatMap((projectContext) => [undefined, true, false].map((engineeringDoctrine) => ({
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(engineeringDoctrine === undefined ? {} : { engineeringDoctrine }),
  })))
  .filter((switches) => Object.keys(switches).length > 0)

/** The recorded identity with each persona hash that a retired prompt switch produced replaced by the current
 *  identity hash of that persona. A recorded hash qualifies only when it equals the current definition with
 *  switches restored, with or without its retired tool-steering and lexicon clauses, hashed without a turn cap or
 *  with its own or a retired one, so any other change still reports as drift. Returns the same identity when no
 *  hash changes. Remove after 2027-04-13. */
export function withoutRetiredPromptSwitches<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => {
    if (persona.kind !== "persona") return []
    const forms = lexiconForms(persona).flatMap((form) => [form, withRetiredText(form, RETIRED_TOOL_STEERING)]).filter((form) => form !== undefined)
    return forms.flatMap((form) => RETIRED_PROMPT_SWITCHES.flatMap((switches) => budgetedHashes({ ...form, ...switches }, persona.maxTurns)))
  })
}

/** The recorded identity with each persona hash that the retired reviewer-uat wall-clock budget produced replaced
 *  by the current identity hash of that persona. A recorded hash qualifies only when it equals the current
 *  definition with exactly those clauses and its lexicon clauses restored, with no prompt switch or a retired one,
 *  hashed without a turn cap or with its own or a retired one, so any other change still reports as drift. Returns
 *  the same identity when no hash changes. Remove after 2027-04-15. */
export function withoutRetiredScenarioBudget<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => lexiconForms(persona).flatMap((form) => {
    const retired = withRetiredText(form, RETIRED_SCENARIO_BUDGET)
    return retired ? [{}, ...RETIRED_PROMPT_SWITCHES].flatMap((switches) => budgetedHashes({ ...retired, ...switches }, persona.maxTurns)) : []
  }))
}

/** The recorded identity with each persona hash that the text before the workflow lexicon produced replaced by the
 *  current identity hash of that persona. A recorded hash qualifies only when it equals the current definition with
 *  exactly its lexicon clauses restored, hashed without a turn cap, so any other change still reports as drift.
 *  Returns the same identity when no hash changes. Remove after 2027-04-30. */
export function withoutRetiredLexiconText<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => {
    const retired = withRetiredText(persona, RETIRED_LEXICON_TEXT)
    return retired ? [personaIdentitySha256(retired)] : []
  })
}

/** The recorded identity with what the trial advisor default reaches (refer to `workflowAgentSubagents`) added at
 *  its current hashes, when the recorded identity names none of the default's personas: a build before the default
 *  pinned only the personas the authored lists reach and the skills those personas require. The default composes
 *  as `composedIdentity` composes it, so the added entries are the personas it reaches and their required skill
 *  closure. Only an entry the recorded identity lacks is added, so every recorded hash stays and an edited advisor
 *  or skill still reports as drift. Returns the same identity when it names the advisor or adds nothing. Remove
 *  after 2027-05-01. */
export function withDefaultAdvisor<Identity extends DefinitionIdentity>(
  identity: Identity,
  workflowId: string,
  options: DefinitionIdentityOptions,
): Identity {
  const recordedPersonas = new Set(identity.personas.map(({ personaName }) => personaName))
  const defaults = workflowAgentSubagents({ subagents: [] })
  if (defaults.some((name) => recordedPersonas.has(name))) return identity
  const reached = composedIdentity(workflowId, [{ subagents: defaults, dependencies: [] }], options)
  const recordedSkills = new Set(identity.skills.map(({ skillId }) => skillId))
  // An unresolved entry hashes as missing, which equals an absent entry, so only a resolved one is a difference.
  const personas = reached.personas.filter(({ personaName, sha256 }) => sha256 !== null && !recordedPersonas.has(personaName))
  const skills = reached.skills.filter(({ skillId, sha256 }) => sha256 !== null && !recordedSkills.has(skillId))
  if (personas.length === 0 && skills.length === 0) return identity
  return {
    ...identity,
    personas: [...identity.personas, ...personas].sort((left, right) => left.personaName < right.personaName ? -1 : 1),
    skills: [...identity.skills, ...skills].sort((left, right) => left.skillId < right.skillId ? -1 : 1),
  }
}

/** The result of `adopt`, a proof that compares the recorded persona hashes with the current definitions, as it
 *  reads when each persona hash that the text before the workflow lexicon produced is first proven current. Each
 *  such persona keeps its recorded hash in the result, so `adopt` records no persona change and the lexicon proof,
 *  which comes later in the chain, records it. Returns the same identity when `adopt` adopts nothing. Remove after
 *  2027-04-30. */
export function acrossRetiredLexicon(
  identity: DefinitionIdentity,
  personas: ReadonlyMap<string, AgentDefinition>,
  adopt: (identity: DefinitionIdentity) => DefinitionIdentity,
): DefinitionIdentity {
  const proven = withoutRetiredLexiconText(identity, personas)
  const adopted = adopt(proven)
  if (adopted === proven) return identity
  if (proven === identity) return adopted
  const recorded = new Map(identity.personas.map(({ personaName, sha256 }) => [personaName, sha256]))
  const lexical = new Map(proven.personas.map(({ personaName, sha256 }) => [personaName, sha256]))
  return {
    ...adopted,
    personas: adopted.personas.map((entry) => {
      const before = recorded.get(entry.personaName)
      return before !== undefined && before !== lexical.get(entry.personaName) && entry.sha256 === lexical.get(entry.personaName)
        ? { ...entry, sha256: before }
        : entry
    }),
  }
}
