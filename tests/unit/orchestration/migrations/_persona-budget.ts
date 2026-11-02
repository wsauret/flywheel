import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"

/** A bundled persona with the turn cap that the builds before the persona
 *  budget cut shipped, whose persona hashes covered the turn cap. A test that
 *  rebuilds a hash such a build recorded starts from this persona. */
export function beforeBudgetCut<Definition extends AgentDefinition>(persona: Definition): Definition {
  const retired = persona.name === "implementer" ? 150
    : persona.name === "ship" ? 40
    : persona.name === "advisor" || persona.name.startsWith("reviewer-") ? 50
    : persona.maxTurns
  return { ...persona, maxTurns: retired }
}

/** A bundled persona as the builds before agents chose their tools freely
 *  shipped it: explorer and advisor still steered agents to the file tools
 *  over the shell. A test that rebuilds a hash such a build recorded starts
 *  from this persona. */
export function beforeToolSteeringCut<Definition extends AgentDefinition>(persona: Definition): Definition {
  if (persona.kind !== "persona") return persona
  const systemPrompt = persona.name === "explorer"
    ? persona.systemPrompt.replace(
      "- Use whichever tools fit: the file tools or read-only shell commands both work for discovery, search, and reading.\n- For GitHub repository data, use read-only `gh` commands through bash or exec for pull requests",
      "- Use your dedicated tools for all file operations. NEVER use shell execution for tasks a dedicated tool handles:\n  - File discovery: use list (NOT shell find/ls)\n  - Content search: use search (NOT shell grep/rg/ack)\n  - Reading files: use read (NOT shell cat/head/tail/less)\n  - GitHub repository data: use read-only `gh` commands through bash or exec (NOT web) for pull requests",
    ).replace(
      "Use web only when `gh` is unavailable or cannot provide the required data.\n- Stay strictly",
      "Use web only when `gh` is unavailable or cannot provide the required data.\n  - External pages: use web (NOT shell curl/wget)\n  - Shell execution (bash or exec) is ONLY for commands with no dedicated tool equivalent: git and gh inspection, wc, etc.\n- Stay strictly",
    )
    : persona.name === "advisor"
      ? persona.systemPrompt.replace("your recommendation. Do not implement", "your recommendation. Use dedicated file tools instead of shell commands for file discovery, content search, and file reads. Do not implement")
      : persona.systemPrompt
  return { ...persona, systemPrompt }
}

/** A bundled persona as the builds before subagents shared the step prompt
 *  shipped it: explorer turned off project context and the engineering
 *  doctrine in its definition. A test that rebuilds a hash such a build
 *  recorded starts from this persona. */
export function beforePromptSwitchCut<Definition extends AgentDefinition>(persona: Definition): Definition {
  return persona.kind === "persona" && persona.name === "explorer"
    ? { ...persona, projectContext: false, engineeringDoctrine: false }
    : persona
}

/** A bundled persona as the builds before the workflow lexicon shipped it: explorer worked one of two lanes that a
 *  dispatch brief selected, reviewer-uat named workflow steps, and reviewer-plan-elegance named the parts of a plan
 *  phases. A test that rebuilds a hash such a build recorded starts from this persona. */
export function beforeLexiconCut<Definition extends AgentDefinition>(persona: Definition): Definition {
  if (persona.kind !== "persona") return persona
  const clauses: readonly (readonly [current: string, retired: string])[] = persona.name === "explorer"
    ? [
      ["The brief selects one of two modes, targeted", "The dispatch brief selects one of two lanes, targeted"],
      ["You are a focused investigator working in one of two modes. The brief selects the mode: work in the targeted mode unless", "You are a focused investigator working one of two lanes. The dispatch brief selects the lane: work the targeted lane unless"],
      ["## Targeted mode (default)", "## Targeted lane (default)"],
      ["## Enumerative mode (when", "## Enumerative lane (when"],
      ["In this mode a missed integration point", "In this lane a missed integration point"],
    ]
    : persona.name === "reviewer-uat"
      ? [["Long model responses or agents of a workflow do not justify", "Long model responses or workflow steps do not justify"]]
      : persona.name === "reviewer-plan-elegance"
        ? [["lens across milestones, ownership", "lens across phases, ownership"]]
        : []
  const missing = clauses.find(([current]) => !persona.description.includes(current) && !persona.systemPrompt.includes(current))
  if (missing) throw new Error(`Persona ${persona.name} lacks the clause: ${missing[0]}`)
  const restore = (text: string) => clauses.reduce((restored, [current, retired]) => restored.replace(current, retired), text)
  return { ...persona, description: restore(persona.description), systemPrompt: restore(persona.systemPrompt) }
}

/** A bundled reviewer-uat persona as the builds before it dropped its ten-minute wall-clock budget shipped it. Start
 *  from {@link beforeLexiconCut}, because those builds also predate the workflow lexicon. */
export function beforeScenarioBudgetCut<Definition extends AgentDefinition>(persona: Definition): Definition {
  if (persona.kind !== "persona" || persona.name !== "reviewer-uat") return persona
  const clauses: readonly (readonly [current: string, retired: string])[] = [
    [
      "## The Live Scenario Budget\n\nAllow a live scenario to take as long as the product needs. There is no fixed wall-clock cap. Keep each drive command short, observe its result, then choose the next action. Long model responses or workflow steps do not justify a blind end-to-end script.",
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
  ]
  const systemPrompt = clauses.reduce((restored, [current, retired]) => {
    if (!restored.includes(current)) throw new Error(`Persona ${persona.name} lacks the clause: ${current.slice(0, 40)}`)
    return restored.replace(current, retired)
  }, persona.systemPrompt)
  return { ...persona, systemPrompt }
}
