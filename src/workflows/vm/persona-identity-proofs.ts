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
  return adoptProvenBeforeBundledMark(identity, personas, (persona) => {
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
  return adoptProvenBeforeBundledMark(identity, personas, (persona) => lexiconForms(persona).flatMap((form) => {
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
  return adoptProvenBeforeBundledMark(identity, personas, (persona) => {
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
  return adoptProvenBeforeBundledMark(identity, personas, (persona) => lexiconForms(persona).flatMap((form) => {
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
  return adoptProvenBeforeBundledMark(identity, personas, (persona) => {
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

/** Every agent name a dispatch that starts at `roots` reached in a build before family roles (refer to `roleCovers`):
 *  `reachableAgentNames` as it walked when a grant covered only a persona of exactly the granted role. Remove after
 *  2027-05-10. */
export function reachedByExactGrants(roots: Iterable<string>, registry: ReadonlyMap<string, AgentDefinition>): readonly string[] {
  const reached = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || reached.has(name)) continue
    reached.add(name)
    const roles = registry.get(name)?.subagentRoles ?? []
    for (const [granted, candidate] of registry) {
      if (granted !== name && candidate.kind === "persona" && roles.includes(candidate.role)) pending.push(granted)
    }
  }
  return [...reached].sort()
}

/** The recorded identity with the personas that `agents` reach only through a family role grant, and the skills only
 *  those personas require, added at their current hashes, when the recorded identity names none of those personas: a
 *  build before family roles walked the grants with `reachedByExactGrants`, so the `reviewer` grant of the general
 *  agent reached no reviewer persona. A build with family roles pinned every persona that a family grant reached, so
 *  an identity that names one of them is current, and a family persona that it lacks was added after the pause and
 *  still reports as drift. Only an entry the recorded identity lacks is added, so every recorded hash stays and an
 *  edited persona or skill still reports as drift. Returns the same identity when it adds nothing. Remove after
 *  2027-05-10. */
export function withFamilyRoleGrants<Identity extends DefinitionIdentity>(
  identity: Identity,
  workflowId: string,
  agents: Parameters<typeof composedIdentity>[1],
  options: DefinitionIdentityOptions,
): Identity {
  const reached = composedIdentity(workflowId, agents, options)
  const exact = composedIdentity(workflowId, agents, options, reachedByExactGrants)
  const exactPersonas = new Set(exact.personas.map(({ personaName }) => personaName))
  const exactSkills = new Set(exact.skills.map(({ skillId }) => skillId))
  const recordedPersonas = new Set(identity.personas.map(({ personaName }) => personaName))
  const recordedSkills = new Set(identity.skills.map(({ skillId }) => skillId))
  const familyOnly = reached.personas.filter(({ personaName }) => !exactPersonas.has(personaName))
  if (familyOnly.length === 0 || familyOnly.some(({ personaName }) => recordedPersonas.has(personaName))) return identity
  // A grant reaches only a resolved persona, but a required skill can be unresolved. Its entry hashes as missing,
  // which equals an absent entry, so only a resolved one is a difference.
  const skills = reached.skills.filter(({ skillId, sha256 }) => sha256 !== null && !exactSkills.has(skillId) && !recordedSkills.has(skillId))
  return {
    ...identity,
    personas: [...identity.personas, ...familyOnly].sort((left, right) => left.personaName < right.personaName ? -1 : 1),
    skills: [...identity.skills, ...skills].sort((left, right) => left.skillId < right.skillId ? -1 : 1),
  }
}

/** An edit of the bundled personas since persona identity covered the bundled mark: each clause it rewrote, paired
 *  with the exact text it replaced, and whether it started to mark bundled personas. */
interface BundledPersonaEdit {
  readonly retired: RetiredPersonaText
  readonly marks?: true
}

/** 2026-11-07 (78b5473c9): capability markers replaced the clauses that named tools, and persona identity started to
 *  cover the bundled mark. Remove after 2027-05-11. */
const CAPABILITY_MARKERS: BundledPersonaEdit = {
  marks: true,
  retired: new Map([
    ["advisor", [[
      "Inspect the repository read-only, only to verify",
      "Use read, search, list, and read-only shell commands only to verify",
    ]]],
    ["explorer", [
      ["and makes targeted external lookups such as documentation.", "and makes targeted non-repository external lookups such as documentation with the web tool."],
      [
        "- **Locate before reading.** Find every plausibly relevant location, then read only the functions or line ranges you need. Do not read entire files to find one function.",
        "- **Search before reading.** Use search to locate relevant code, then read only the functions or line ranges that matter. Do not read entire files to find one function; use `symbol:` or `offset`/`limit` to read just what you need.",
      ],
      [
        "- **Enumerate before reading.** First find every location plausibly relevant to your facet.",
        "- **Enumerate before reading.** First surface every location plausibly relevant to your facet with search and list.",
      ],
      [
        "- Use whichever of your tools fit for discovery, search, and reading.\n{{if:bash}}\n- For GitHub repository data, use read-only `gh` commands through bash or exec for pull requests, commits, diffs, reviews, and issues.\n{{end}}\n{{if:web}}\n- Use web only for data that your other tools cannot provide.\n{{end}}",
        "- Use whichever tools fit: the file tools or read-only shell commands both work for discovery, search, and reading.\n- For GitHub repository data, use read-only `gh` commands through bash or exec for pull requests, commits, diffs, reviews, and issues. Use web only when `gh` is unavailable or cannot provide the required data.",
      ],
    ]],
    ["implementer", [[
      "{{if:read}}\n- Use the read, file edit, and write tools for project files; shell sed, cat, and heredoc scripts are not substitutes.\n{{else}}\n- Read and change project files with the tools you hold.\n{{end}}\n{{if:search}}\n- Use the search and list tools to find project files and text; shell grep and ls are not substitutes.\n{{end}}",
      "- Use the read, search, file edit, and write tools for project files; bash grep, sed, cat, ls, and heredoc scripts are not substitutes.",
    ]]],
    ["ship", [
      ["{{if:bash}}\nFollow the composed Ship method.", "Follow the composed Ship method."],
      ["Keep commit-message drafts and other publication scratch files", "You may use Write or Bash to create commit-message drafts and other publication scratch files"],
      ["or modify repository file contents.\n{{else}}\nYou have no shell, so you cannot inspect, commit, or push. Change nothing and return Not published, with the missing shell as the condition that stopped publication.\n{{end}}", "or modify repository file contents."],
    ]],
    ["reviewer-uat", [[
      "{{if:bash}}\nBound each bash invocation with the tool's timeout parameter. Do not use the `timeout` shell utility. A single command must remain bounded:\n{{else}}\nA single command must remain bounded:\n{{end}}",
      "Bound each bash invocation with the tool's timeout parameter. Do not use the `timeout` shell utility. A single command must remain bounded:",
    ]]],
  ]),
}

/** 2026-11-10 (588fa3a9f): reviewer-uat named its fellow reviewers behind an agent-type marker, when agent types
 *  became capability terms, and explorer and implementer stopped telling the dispatcher to dispatch general instead.
 *  Remove after 2027-05-11. */
const AGENT_TYPE_MARKERS: BundledPersonaEdit = {
  retired: new Map([
    ["reviewer-uat", [[
      "{{if:type:reviewer-quality&type:reviewer-performance&type:reviewer-data-integrity&type:reviewer-security&type:reviewer-elegance}}\nThe code-reading personas use target-specific names such as `reviewer-code-quality`, `reviewer-code-performance`, `reviewer-code-data-integrity`, `reviewer-code-security`, and `reviewer-code-elegance`. They judge implementation evidence. You remain the outside-code observer and report only what the public surface did.\n{{else}}\nThe code-reading reviewer personas judge implementation evidence. You remain the outside-code observer and report only what the public surface did.\n{{end}}",
      "The code-reading personas use target-specific names such as `reviewer-code-quality`, `reviewer-code-performance`, `reviewer-code-data-integrity`, `reviewer-code-security`, and `reviewer-code-elegance`. They judge implementation evidence. You remain the outside-code observer and report only what the public surface did.",
    ]]],
    ["explorer", [["when the brief asks for full coverage.", "when the brief asks for full coverage. For investigation that needs your full intelligence, dispatch general instead."]]],
    ["implementer", [["with full tool access.", "with full tool access. For open-ended work that needs your own judgment and conversation context, dispatch general instead."]]],
  ]),
}

/** 2026-11-10 (e3297eb73): reviewer-uat got the block that tells it where its shell admits writes, which replaced no
 *  text. Remove after 2027-05-10. */
const UAT_SCRATCHPAD_RULE: BundledPersonaEdit = {
  retired: new Map([
    ["reviewer-uat", [[
      "\n\n{{if:bash}}\nCreate every fixture, isolated home, and evidence file inside your scratchpad, and name each one with a literal path, not a shell variable; the shell refuses other writes.\n{{end}}",
      "",
    ]]],
  ]),
}

/** 2026-11-11: explorer stopped claiming that it runs on a cheaper model, which is false when every role resolves to
 *  one model. Remove after 2027-05-11. */
const EXPLORER_MODEL_CLAIM: BundledPersonaEdit = {
  retired: new Map([
    ["explorer", [["Fast read-only investigation. Answers", "Fast read-only investigation on a cheaper model. Answers"]]],
  ]),
}

/** Every edit of the bundled personas since persona identity covered the bundled mark, newest first. */
const BUNDLED_PERSONA_EDITS = [EXPLORER_MODEL_CLAIM, UAT_SCRATCHPAD_RULE, AGENT_TYPE_MARKERS, CAPABILITY_MARKERS] as const

/** `persona` as it read before `edit`, with `edit` and every later edit undone, when it is a bundled persona that
 *  `edit` names; an edit that marks names every bundled persona. Undefined for any other persona, or when its text
 *  lacks a clause that one of those edits rewrote. */
function bundledPersonaBefore(persona: AgentDefinition, edit: BundledPersonaEdit): AgentDefinition | undefined {
  if (persona.kind !== "persona" || persona.bundled !== true || !(edit.marks || edit.retired.has(persona.name))) return undefined
  const undone = BUNDLED_PERSONA_EDITS.slice(0, BUNDLED_PERSONA_EDITS.indexOf(edit) + 1)
  const form = undone.reduce<AgentDefinition | undefined>((earlier, { retired }) => earlier && retired.has(earlier.name) ? withRetiredText(earlier, retired) : earlier, persona)
  if (form?.kind !== "persona" || !undone.some(({ marks }) => marks)) return form
  const { bundled: _mark, ...unmarked } = form
  return unmarked
}

/** The personas as they read before `edit`: each bundled persona with `edit` and every later edit undone, and any
 *  other persona as it is. */
function personasBefore(personas: ReadonlyMap<string, AgentDefinition>, edit: BundledPersonaEdit): ReadonlyMap<string, AgentDefinition> {
  return new Map([...personas].map(([name, persona]) => [name, bundledPersonaBefore(persona, edit) ?? persona]))
}

/** `adoptProvenPersonas` over the personas as they read before the bundled mark, which every proof of an older edit
 *  reads. The hashes it adopts are those of that era, and `withCapabilityMarkers` adopts them in turn. */
function adoptProvenBeforeBundledMark<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
  hashes: (persona: AgentDefinition) => readonly string[],
): Identity {
  return adoptProvenPersonas(identity, personasBefore(personas, CAPABILITY_MARKERS), hashes)
}

/** The recorded identity with each persona hash that a bundled persona produced before one of `edits` replaced by
 *  the current identity hash of that persona. A recorded hash qualifies only when it equals the current definition
 *  with exactly that edit and every later edit undone, so any other change still reports as drift. Returns the same
 *  identity when no hash changes. */
function adoptBefore<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
  edits: readonly BundledPersonaEdit[],
): Identity {
  return adoptProvenPersonas(identity, personas, (persona) => edits.flatMap((edit) => {
    const form = bundledPersonaBefore(persona, edit)
    return form ? [personaIdentitySha256(form)] : []
  }))
}

/** The recorded identity with each reviewer-uat hash that a build before its scratchpad rule produced replaced by
 *  the current identity hash (refer to `adoptBefore`). Remove after 2027-05-10. */
export function withUatScratchpadRule<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptBefore(identity, personas, [UAT_SCRATCHPAD_RULE])
}

/** The recorded identity with each persona hash that a build before the capability-marker edits produced replaced
 *  by the current identity hash (refer to `adoptBefore`): a bundled persona before 2026-11-07, which the proofs of
 *  older edits leave in that form, or a persona that the edit of 2026-11-10 names between the two edits. Remove
 *  after 2027-05-11. */
export function withCapabilityMarkers<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptBefore(identity, personas, [AGENT_TYPE_MARKERS, CAPABILITY_MARKERS])
}

/** The recorded identity with each explorer hash that the description claiming a cheaper model produced replaced by
 *  the current identity hash (refer to `adoptBefore`). Remove after 2027-05-11. */
export function withoutExplorerModelClaim<Identity extends DefinitionIdentity>(
  identity: Identity,
  personas: ReadonlyMap<string, AgentDefinition>,
): Identity {
  return adoptBefore(identity, personas, [EXPLORER_MODEL_CLAIM])
}

/** The result of `adopt`, a proof that compares the recorded persona hashes with the personas it receives, as it
 *  reads when each persona hash that the text before the workflow lexicon produced is first proven current. `adopt`
 *  receives the personas as they read before the bundled mark, which the lexicon proof also reads. Each such persona
 *  keeps its recorded hash in the result, so `adopt` records no persona change and the lexicon proof, which comes
 *  later in the chain, records it. Returns the same identity when `adopt` adopts nothing. Remove after 2027-04-30. */
export function acrossRetiredLexicon(
  identity: DefinitionIdentity,
  personas: ReadonlyMap<string, AgentDefinition>,
  adopt: (identity: DefinitionIdentity, personas: ReadonlyMap<string, AgentDefinition>) => DefinitionIdentity,
): DefinitionIdentity {
  const proven = withoutRetiredLexiconText(identity, personas)
  const adopted = adopt(proven, personasBefore(personas, CAPABILITY_MARKERS))
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
