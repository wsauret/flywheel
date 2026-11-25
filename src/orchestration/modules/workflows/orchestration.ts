import type { CapabilityCheck } from "../../../infra/definitions/capability-text.js"

/** How the root chat runs substantive work while Workflows is On:
 *  through workflows by default (PI-AGENT-031); the workflow tool description
 *  states how to write and launch the file (PI-AGENT-110). The chat body's
 *  sizing rule says to start a workflow only on a named trigger, so this
 *  section states that it comes first for that one choice. A subagent or an agent of a workflow does not get it, so a workflow
 *  never launches another workflow only because it was launched. In Ask mode every launch waits
 *  for the person, so the chat launches on its own judgment instead. Elapsed
 *  time is a constraint: told that it was not, a chat saw that most units of a
 *  14-unit plan were independent and still ran them one at a time for hours.
 *  It renders from the tree check, so it names subagents only where they exist. */
export const orchestrationSection = (has: CapabilityCheck): string => `# Orchestrating with workflows

Workflows is On: aim for the most complete and correct result, not the cheapest one, and reach it as soon as possible. Delegate every substantive task; token cost is not a constraint. A substantive task is reason enough to delegate: for that choice, this section comes before the rule that orchestration must pay for itself. That rule still sizes each workflow and each dispatch. Work without delegation only on conversational turns and trivial mechanical edits.

- Run the parts of one task, such as understand, design, and implement, as several dispatches in sequence, one for each part, and read each result before you start the next part. A part holds all of its own agents: the implement workflow builds, reviews, repairs the confirmed findings, and verifies the repair, never in later dispatches or a second workflow${has("type:reviewer-quality") && has("type:reviewer-elegance") && has("type:implementer") ? " (`examples/build-review-loop.workflow.yaml` in `workflow-authoring`)" : ""}.${has("subagent") && has("type:implementer") ? " A unit that the review method calls small needs no workflow: give it to one implementer subagent, which its gates validate." : ""} End a part only where the person must decide, such as approval of a design or whether to pay for a run: ask the person, and pass the answer as \`input\` to the next workflow.
- Start independent units of work at the same time. Before a plan of several units starts, list the prerequisites of each unit and the files that it changes. A unit waits only for a named prerequisite or a file that a running unit changes; the order in which units commit is not a reason to wait, and a running dispatch is no reason to leave a unit that can start unstarted.
- Size the verification of a finding to the cost of acting on a wrong one: one refuter for a finding that goes to the person or to an expensive repair, and several votes only for a finding that blocks a release or cannot be undone.`

/** The same mode stated beside the person's turns. The prompt section alone did
 *  not move the model: on plain requests it read the sizing rule and worked
 *  alone on 24 of 24 tasks, and this reminder made it launch (ARCH-CONTEXT-022).
 *  Each statement renders from the agent check of the request that states it. */
export const ORCHESTRATION_REMINDER = {
  on: (has: CapabilityCheck) => `Workflows is On: aim for the most complete and correct answer, not the cheapest one, and reach it as soon as possible. Delegate every substantive task; token cost is not a constraint. Use a workflow only when a later agent reads the output of an earlier one${has("subagent") ? "; use subagents for one agent or for agents that can run at the same time" : ""}. Start independent units of work at the same time: a unit waits only for a named prerequisite or a file that a running unit changes. Refer to the Orchestrating with workflows section. Work without delegation only on conversational turns and trivial mechanical edits.`,
  still: () => "Workflows is still On: delegate substantive tasks, start independent units of work at the same time, and use a workflow only when a later agent reads the output of an earlier one.",
  // In Ask mode the workflow tool stays, so the launch sentence stays with it.
  off: (has: CapabilityCheck) => `Workflows is no longer On: stop delegating every substantive task. Do the work directly${has("subagent") ? ", or delegate a focused task when it pays for itself" : ""}.${has("workflow") ? " Launch a workflow only when the task needs one." : ""}`,
  every: 10,
  // The unmarked statements of 138aad9ac, which conversations written before
  // the mode marker hold. Remove the conversion after 2027-01-15.
  retired: {
    "<system-reminder>\nAd hoc workflows is on: aim for the most complete and correct answer, not the fastest or cheapest one. Run every substantive task through a workflow; token cost is not a constraint. Refer to the Orchestrating with workflows section. Work without a workflow only on conversational turns and trivial mechanical edits.\n</system-reminder>": "on",
    "<system-reminder>\nAd hoc workflows is still on: run substantive tasks through workflows.\n</system-reminder>": "still",
    "<system-reminder>\nAd hoc workflows is off: launch only a registered workflow, and only when its purpose fits the task.\n</system-reminder>": "off",
  },
} as const
