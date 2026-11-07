import type { CapabilityCheck } from "../../../infra/capability-text.js";
import { SKILL_BODY_BUDGET_CHARS } from "../../../workflows/skill-schema.js";

/** Review prompts for the learning fork: the read
 *  tool is `skill` (action list / load / resource), the write tool is
 *  `skill_manage` (save / patch / remove_file / archive / restore), support
 *  files live under `assets/`, protection is the `managed` marker, and
 *  and overlap between two existing skills is noted in the reply rather than
 *  merged here: merging is a separate user-invoked pass
 *  (`flywheel skills maintain`), because merging rewrites durable artifacts
 *  and a turn-end review is the wrong place to decide that.
 *
 *  The classifier (ARCH-LEARNING-002, ARCH-LEARNING-013): every observation has one canonical
 *  destination and one reach, a review trigger is an obligation to evaluate
 *  rather than to write, and this background actor cannot mutate a global
 *  skill. `learningClassifier` is that contract in one place; each prompt
 *  includes it, so the three review halves cannot drift apart. Each text is a
 *  function of the review's capability check, so a review that cannot write a
 *  skill reads no skill guidance (ARCH-CONTEXT-033). */

function learningClassifier(has: CapabilityCheck): string {
  const skills = has("skill_manage");
  return `Classify each observation before you write anything. Every observation has exactly one canonical destination:

Memory is a scarce, selective profile of the user and their working context, not a session record. Save only evidenced facts likely to change an agent's decisions across many future sessions and absent from an existing authority. Prioritize lasting user preferences and context; saving nothing is often correct.

- Preference (how the user wants interaction, code, or work presented) -> global memory when it applies everywhere; a preference about how work is done in this project -> project memory.${skills ? " A preference is never a skill." : ""}
- Stable user fact (who the user is, their role, how they work across projects) -> global memory.
- Hard-won repository or tool fact (durable working context that is not an instruction or cheaply rediscovered) -> memory at the narrowest applicable reach, only when it meets the selective test above.
- Repository instructions, commands, conventions, and architectural guidance -> AGENTS.md or their existing repository authority, not memory. This background review has no file-editing authority: do not edit repository files; identify the destination in your reply.
- Session notes (progress, plans, handoffs, temporary findings, and completed-work summaries) -> the separate session-notes surface, never memory. Do not write session notes in this learning review.
- Repeatable procedure (a method for a class of work, with a routing trigger, steps, verification, and failure guidance) -> ${skills ? "a project skill" : "not memory. Name it in your reply"}.
- Enforceable rule (something code, a test, a schema, or the project instructions can guarantee) -> not durable learning. Say so in your reply.
- Derivable information (available cheaply right now from the code, git, or configuration) -> not durable learning. A future session reads it fresh.

Reach: project learning applies to this project root only; global learning follows the user into every project. Generated learning defaults to project, and ambiguous applicability stays project. Preferences and stable user facts are the exception only when their subject is the user across projects; a preference tied to this project or its tooling stays project.${skills ? `

Global skills: you are an autonomous actor with no user present, so you cannot create, rewrite, patch, archive, restore, or change support files in a global package. The storage boundary refuses those writes. Write a project skill instead. When a project skill you can see is genuinely a general procedure that belongs in every project, record the proposal with skill_manage action recommend (name only): it writes nothing global and hands the decision to the next interactive session, which asks the user.` : ""}

Save nothing for: transient failures that resolved before the session ended, unresolved failures where no working method was found, negative capability claims ("tool X does not work"), one-off task narratives, and anything a future session can rederive cheaply. A mistake or verified fix alone does not qualify as memory; classify it first.

Write what the transcript evidences - user statements, tool outcomes, verified fixes - not what you asserted about yourself.

'Nothing to save.' is a correct and complete outcome. A review is an obligation to evaluate the evidence, not an obligation to write.`;
}

const SKILL_REVIEW_CORE = `Target shape of the library: CLASS-LEVEL skills, each with a SKILL.md that carries the method and support files that carry the evidence. Not a long flat list of narrow one-session-one-skill entries. This shapes HOW you write a procedure down, not WHETHER the evidence establishes one.

Write the body small. A SKILL.md body enters an agent's context in full every time the skill is selected, so its size is paid on every future load; a file under references/ costs one manifest line until something asks for it. The body has a ${SKILL_BODY_BUDGET_CHARS.toLocaleString("en-US")}-character budget and a write over it is refused. So decide where content goes as you write it, not afterwards:
- The method, its decision rules, its ordering constraints, and the failure modes that change what an agent does: the body.
- A case-specific playbook, an error transcript, a reproduction recipe, a provider quirk, a long example: references/<topic>.md, with one line in the body naming that path and when to read it. This holds for what you are writing now, not only for what is already there. Being the newest thing learned is not a reason to keep it in the body; if it were, the body would always hold whatever was written last, which is not an organising principle. Put it where its shape says it goes, and match what the skill already does with content of that shape.
- One reference is one topic a reader would want on its own. If its name needs "and", it is probably two files. Do not create a reference under about 1,200 characters; that costs a whole tool call for almost nothing.
Adding a case-specific block under a general heading is how a body silently grows past its budget: each session appends one, and none of them look large alone.

Preference order - prefer the earliest action that fits:
  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation for skills that it loaded. If any of them covers the territory of the new procedure, PATCH that one first (skill_manage action patch). It is the skill that was in play, so it is the right one to extend - but only if it is managed (managed: flywheel). Bundled and user-pinned skills are off-limits no matter how relevant (see Protected skills below); for those, fall through to the next option.
  2. UPDATE AN EXISTING UMBRELLA (skill action list, then load the candidate). If no loaded skill fits but an existing class-level skill does, patch it. Add a subsection, a pitfall, or broaden a trigger.
  3. ADD A SUPPORT FILE under an existing umbrella (skill_manage action save with a path). Four kinds - use the right directory per kind:
     - references/<topic>.md - session-specific detail (error transcripts, reproduction recipes, provider quirks) AND condensed knowledge banks: quoted research, API docs, external authoritative excerpts, or domain notes you found while working on the problem. Write it concise and for the value of the task, not as a full mirror of upstream docs.
     - templates/<name>.<ext> - starter files meant to be copied and modified (boilerplate configs, scaffolding, a known-good example to reproduce with modifications).
     - scripts/<name>.<ext> - statically re-runnable actions the skill can invoke directly (verification scripts, fixture generators, deterministic probes, anything the agent should run rather than hand-type each time).
     - assets/<name>.<ext> - static fixtures the skill's instructions point at.
     The umbrella's SKILL.md should gain a one-line pointer to any new support file (skill_manage action patch) so future agents know it exists.
  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL (skill_manage action save) when no existing skill covers the class. The name MUST be at the class level. The name MUST NOT be a specific PR number, error string, feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the proposed name only makes sense for today's task, it is wrong - fall back to (1), (2), or (3).

Before you add to a skill, read what it already claims about the same thing. When what you learned contradicts a claim the skill states, correct that claim rather than appending a case underneath it. A skill that states a rule and then, further down, describes a case that breaks the rule is worse than one that never stated the rule, because a reader cannot tell which is current. Watch for "always", "never", and "exactly one of" near the top of a body; those are the claims a new case most often falsifies.

A correction the user made can carry two things at once: a preference about how they want work presented, and a defect in the procedure you followed. Send each part to its own destination. The preference goes to global memory; only the procedural part changes a skill.

If you notice two existing skills that overlap, note it in your reply so the user can merge them with flywheel skills maintain.

If a write is refused for the body budget, the refusal names the deficit and the largest sections. Do not abandon what you were saving: free at least the deficit in the same mutation and reissue it with your change included. Demote a case-specific block first, because that is the move with real capacity; a body that is already dense returns almost nothing to condensing. Delete only what a session can rederive from current code, git, or configuration, or what a later section supersedes. Text you move stays verbatim, including its list numbering; the body you leave behind is yours to renumber.

Protected skills (DO NOT edit these):
- Bundled skills (shipped with the runtime).
- Skills installed in shared roots the runtime does not own (~/.agents/skills).
- Skills marked managed: user - the user hand-wrote or claimed them. You are an autonomous no-user-present actor, so their pin blocks your writes entirely, content updates included, and this covers skills that were loaded or consulted this session: being in play does not make one yours to edit. If such a skill is wrong or outdated, say so in your reply and recommend the change to the user - do not try to patch it.
If the only skills that need updating are protected, say 'Nothing to save.' and stop.

Record what cost this session time and would shorten the next session's trajectory.`;

/** One half of the learning review: the memory half writes memory, the
 *  skill half writes managed skills. */
export type ReviewHalf = "memory" | "skill";

const REVIEW_TOOLS = ["skill", "skill_manage", "memory"] as const;

/** The review instruction for the halves that fire, with the tool-restriction
 *  suffix. `has` is the check of the tools that the review's admitted grant
 *  holds. The tool schema surface stays byte-stable for the prefix cache, so
 *  the restriction is stated here and enforced at execution rather than by
 *  unlisting tools. */
export function reviewInstruction(halves: readonly ReviewHalf[], has: CapabilityCheck): string {
  const classifier = learningClassifier(has);
  const prompt = halves.length === 2
    ? `Review the conversation above and decide what, if anything, it produced as durable learning.

${classifier}

${SKILL_REVIEW_CORE}

Act on each destination the classifier selects: memory writes go through the memory tool at their reach, and a repeatable procedure goes through skill_manage as a project skill. If the evidence selects no destination, say 'Nothing to save.' and stop.`
    : halves[0] === "memory"
      ? `Review the conversation above and decide what, if anything, it produced as durable memory.

${classifier}

Save each qualifying item with the memory tool, setting target to the reach the classifier gives it. If nothing qualifies, say 'Nothing to save.' and stop.`
      : `Review the conversation above and decide whether it established a repeatable procedure worth a skill.

${classifier}

${SKILL_REVIEW_CORE}

Only a repeatable procedure becomes a skill. Save a preference or fact with the memory tool only when it meets the classifier's selective memory test; otherwise leave memory and the skill library alone.`;
  const tools = REVIEW_TOOLS.filter((tool) => has(tool));
  const named = tools.length === 1 ? tools[0] : `${tools.slice(0, -1).join(", ")}, and ${tools.at(-1)}`;
  return `${prompt}\n\nYou can only use the ${named} tool${tools.length === 1 ? "" : "s"}. Other tools will be denied at runtime; do not attempt them.`;
}
