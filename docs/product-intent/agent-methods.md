# Agent Methods Product Intent

This document states the current intended experience for Flywheel's built-in agent methods and repository-specific extensions.

## PI-AGENT-001: Repository-specific methods are opt-in

Flywheel provides broadly applicable agent methods without imposing one product-development process on every repository. A repository can add stricter domain-specific behavior through project instructions and specialized skills that compose the generic methods. Repositories that do not opt in receive no added ceremony.

## PI-AGENT-002: Broad exploration is bounded and inspectable

Flywheel can inventory and investigate broad multi-system environments through bounded, inspectable work that records coverage and produces reviewable documentation. An incomplete survey still delivers its results, marked as partial.

## PI-AGENT-059: A survey reports its exact coverage

A survey reports how many of its required targets it surveyed out of all of them, and it reports supporting targets separately. It names every target that it did not survey, and why. A target that the scope excluded before the survey does not count against coverage. A survey never claims full coverage while a required target is unsurveyed.

## PI-AGENT-060: A workflow join shows what it dropped

A workflow join that narrows the results of its agents reports what it dropped and why, beside what it kept. A join that removes a duplicate names the item of the agent whose entry it kept. A join that keeps the top entries names each entry below the cut. Each join names the agents that failed, and its result does not depend on the order in which the agents finished.

## PI-AGENT-061: Workflow votes count a failed agent as an abstention

A phase over a list can cast several independent votes on each item, and no vote sees another. Its join gives each item one verdict and reports the valid, refuted, and abstaining votes against its thresholds. An agent that failed counts as an abstention, so a verdict that no agent supported never passes.

## PI-AGENT-062: A repeated search stops when a round finds nothing new

A workflow can repeat a phase over a list until a round finds nothing new, or until its declared number of rounds. Each agent of a later round sees every entry that earlier rounds kept or dropped, so it searches only for new entries. Each round's join drops those earlier entries and names the round that first saw each one. A round in which an agent failed never counts as finding nothing new, because that agent did not search.

## PI-AGENT-003: Chat leads requests through delivery

In chat, Flywheel leads a change request through exploration, design, approval, implementation, verification, and review without the user asking for each next part. The design labels the part that the user fixed as Design intent, and that label travels into every checkpoint, brief, and review that later agents read. A delegated implementation returns to chat as a first draft, and a review checks it for drift from the design beside defects. The chat agent that designed the change revises the draft until it realizes the design and nothing beyond it. Expected drift never reaches the user as a question.

## PI-AGENT-093: Implementation follows the user's intent, not the plan

During implementation, Flywheel follows the user's original intent and does not treat the plan as a fixed script. It resolves discoveries, revises implementation choices and phase order, and widens the necessary file and repair scope without asking permission or stopping because the plan is wrong. It keeps the requested outcomes and the user's explicit prohibitions, and reports each material deviation for the dispatching agent's review. Only a conflict with the approved design itself returns to the user, as a design revision.

## PI-AGENT-094: Agents act one evidence-led change at a time

Flywheel agents work on one coherent change at a time and decide each next step from concrete actions and fresh observations, with the full requested outcome in view. They implement only approaches that evidence supports, and evidence can narrow or remove work without weakening the user's goals, constraints, or explicit decisions. Work that the approved outcome does not need, even an independently useful improvement, does not expand the task. Past observations guide hypotheses but are assumed stale and never substitute for observing the current state.

## PI-AGENT-095: Designs are spiked before the user sees them

Before Flywheel shows a design, it tests its diagnosis and design as hypotheses with throwaway probes of feasibility and mechanism against real code and systems. When inspection cannot tell viable approaches apart, it prototypes and compares them and says what it tests while the tests run. The design backs each claim about what code does with a code citation and every other claim with a spike observation, and labels an unsupported claim as untested theory. A disproving spike changes the approach before the user sees a design. A spike showing the request is infeasible returns that finding with its evidence.

## PI-AGENT-096: Uncovered work gets a complete design to approve

When existing user approval does not cover the work, Flywheel presents a complete design with a recommended implementation route, and the user can approve it, revise it, or ask for an Advisor review first. The design marks each part of its Design intent that the agent inferred, and names its riskiest remaining assumption with the observation that would show it wrong. An answer that rejects the approach sends the work back to spiking with the user's guidance before Flywheel presents a new design. Before an implementation route starts, chat settles every open question through evidence or the user's exact decision.

## PI-AGENT-097: An Advisor review approves only an unchanged design

When the Advisor recommends no material change, its review approves the unchanged design on condition. The reply then shows the Advisor's strongest objection and the condition that would reverse its advice. A material concern or an unavailable review returns the design to the user for a decision.

## PI-AGENT-098: Approval starts delivery without another command

Design approval starts the recommended implementation route at once, without another start command from the user. Feature-feasibility requests enter design, and confirmed bug investigations continue into fix design. A request to design, plan, or brainstorm still continues into delivery, and only an explicit instruction not to implement makes the task design-only. The agents of a workflow then run autonomously, and a revision needs fresh approval only when it exceeds the approved scope or adds a user-owned decision.

## PI-AGENT-099: Broad approval covers fixes within its scope

Broad approval covers independent fixes and newly discovered causes within the user's stated scope, such as a request to fix all broken lint and tests. Under it, Flywheel explains its findings and proceeds without an approval prompt for each fix. Without such approval, an ordinary bug investigation still needs approval of its fix design. Broad approval never authorizes weaker checks, changed product requirements, or actions that need separate consent.

## PI-AGENT-100: A disproved premise is a successful no-change result

An evidence-backed finding that the requested behavior already holds, or that a reported defect does not exist, is a successful no-change outcome. Flywheel then records the rejected premise and the fresh decisive evidence, and it invents no fix and runs no unrelated test. An investigation that ends without decisive evidence is reported as unresolved, never as a no-change success.

## PI-AGENT-101: Verification is the smallest complete fresh proof

Flywheel verifies each change, including a revised draft, with the smallest complete fresh proof of its intended benefit and preserved behavior, and then stops. Tests alone suffice when they establish correctness, and live acceptance testing runs only when needed. Every verification pass observes the current state and never accepts earlier results. After implementation, a claim about an external service, a dependency, or runtime behavior is checked again with a cheap probe against the real system when one is possible.

## PI-AGENT-102: Exhaustive QA observes every surface in every pass

An exhaustive QA campaign makes fresh observations of every surface in every pass, including follow-up passes. Past observations can guide the investigation but never count as current QA verification. A fully exercised clean pass can finish with zero fixes.

## PI-AGENT-054: Published code review is a conversation

Flywheel publishes a change without first stopping to ask for review, and the user then reviews its shape by asking the agent about what they see. The agent answers each review question by explaining the code first. A local objection gets a fix that is verified and published to the same change. An objection to the structure starts a reshape, in which the agent spikes new structures under the user's guidance and the reshaped code passes the proof that the change established.

## PI-AGENT-070: A publication report states its deviations, proof, and gaps

The chat reply that reports a publication ends with the changes from the approved design and their reasons, the proof that the change works, and what that proof does not cover. That last part names what the checks and the review did not exercise, the material choices the agent made where the design was silent, and each P1 or P2 finding set aside with its reason. When the agent cannot say what its checks would miss, it says so and recommends that the user review the change. A pull request that Flywheel opens gives the same content in its description.

## PI-AGENT-055: Agents explain their work in conversation

Flywheel agents explain designs, results, and other artifacts in the conversation in plain terms, so the user never has to open an artifact to understand it. When the user challenges a claim, often by voicing confusion and offering a simpler model, the agent restates the user's model. It names the exact premise where the models differ and settles that premise with evidence. It neither defends its claim nor concedes by reflex. The challenge ends when the agent shows why its approach is better or gives a justification that the user accepts.

## PI-AGENT-004: Paper-cut campaigns resolve verified pain

When the user invokes `/papercuts`, Flywheel validates every live project paper cut against current evidence. It closes records whose pain is resolved, no longer relevant, or not worth fixing. It investigates and prioritizes the remaining work, and resolves one root-cause fix at a time. The campaign continues until the captured backlog is resolved or the user defers it. When approval covers the campaign's scope, fixes inside that scope need no separate approval.

## PI-AGENT-005: File editing fits the serving model

Flywheel gives each supported model a file-editing contract and working instructions suited to that model, keeps the same agent behaviors across models, safely repairs unambiguous formatting drift, and refuses ambiguous edits without changing files. An edit that changes nothing reports its files as unchanged, and a change to several files that fails partway keeps the files it already changed.

## PI-AGENT-006: Filesystem tools follow ordinary directory links

Flywheel's filesystem tools follow directory links to inspect and change user-selected files, including installed skills and Flywheel runtime state, while broad traversal does not enter credential-bearing storage.

## PI-AGENT-007: Agents preserve protected memory

Flywheel agents preserve durable memory that users mark as protected. Each memory entry has a protected flag that the user sets or clears by editing the memory file. Protected entries count toward the memory limit. Memory files from earlier releases stay readable and convert to the current format on the next memory change.

## PI-AGENT-008: Completed repository work is published

Flywheel agents verify, commit, and push each repository-changing unit before they start another unit or report completion. When standard gates fail only because of proven unrelated concurrent changes, agents use relevant unit-scoped verification and continue publication. When the remote holds commits that change a file of the unit, publication stops until the agent verifies its change again on the remote tip.

## PI-AGENT-071: Ship publishes delegated changes

After verification and review, the working agent hands publication to Ship with the files it changed and a short summary of user intent and implemented design. The working agent does no Git analysis and writes no commit message. Ship inspects the selected changes, writes the commit message, commits whole selected files including concurrent edits, and pushes. Ship does not repeat verification, separate changes by author, select hunks, or isolate edits in worktrees.

## PI-AGENT-009: Runtime steering stays private

Flywheel agents keep runtime steering private and give users only task-relevant progress, results, or blockers.

## PI-AGENT-010: Agents preserve session working context

Each conversation has one checkpoint with named sections for the design intent, the user's decisions, the current state, open questions, the next step, relevant skills, references to recorded history, and working notes. Only the agent that owns the conversation reads and changes its checkpoint, through scoped tools and one section at a time. A change that would exceed the checkpoint's size limit is refused with the reason, never cut short. The checkpoint stays current when history is rewound, and every earlier version stays inspectable.

## PI-AGENT-088: Agents keep intent, decisions, and skills current

Agents record the user's design intent in the checkpoint from the moment a request arrives, update it as discussion and experiments change it, and mark it when the user approves it. Each user decision records its date, the user's words, and the decision it replaces. Agents record which loaded skills stay relevant to ongoing work and reload them when they recover context.

## PI-AGENT-089: Executions meet the context limit by how they can recover

Every execution that can compact has the checkpoint tools and instructions to maintain and recover its working context, and other executions do not compact. An attended one stops at the context limit, and an unattended one, such as a workflow agent, continues in a fresh conversation from its brief and recorded progress. An unattended agent that reaches the context limit before it makes any progress fails with the context-limit reason.

## PI-AGENT-090: Compaction saves work and reopens from the checkpoint

Before a planned automatic or manual compaction, including one started from idle, the agent gets a bounded opportunity to save its work, and only the checkpoint tools run. Compaction then starts a fresh context that opens with the current checkpoint instead of a generated summary and points to the recorded history that the agent, including a session-backed subagent, can retrieve. When the context overflows before the agent can save, the opening says that the checkpoint may miss the latest work. The transcript shows the compaction report instead of this opening.

## PI-AGENT-091: Compaction of a waiting chat starts no work

With automatic compaction on, Flywheel compacts a large idle chat before its prompt cache expires, when the provider states a minimum cache lifetime, and the chat stays idle. It does not wake interrupted chats or chats waiting on background work. Users can turn off idle compaction in Settings, and an idle compaction that fails or is interrupted keeps the conversation context. A compaction that the person asks for while a chat waits for them runs at once, starts no turn, and keeps how the last turn ended and whether it offers Resume.

## PI-AGENT-092: Children receive the approved design intent

A subagent, reviewer, or workflow agent that starts while its parent's design intent is approved receives that intent and the user's decisions, with their provenance, and cannot change the parent's checkpoint. The agents of one workflow receive the same snapshot, taken when the workflow starts. A child never receives a design intent that the user has not approved.

## PI-AGENT-011: Memory preserves selective cross-session understanding

Flywheel uses limited memory selectively for durable cross-session understanding of the user and their working context. Session working notes remain separate. Agents maintain shared repository guidance in applicable project instructions rather than duplicating it in memory.

## PI-AGENT-012: Experiment loops start from an approved charter

When the user invokes `/experiment design`, Flywheel leads a charter design conversation. The transcript shows it after an `/experiment design` divider, with the goal as the first user message. The charter states the objective, primary and secondary metrics, hard gates, anti-gaming rules, files in scope, protected and sealed paths, measure and checks commands, baseline procedure, and search strategy. Before the charter is complete, Flywheel proves that the measure command emits the declared metrics. The charter and its scripts are user-owned repository files. An experiment loop cannot start without a complete charter whose primary metric has been produced at least once.

## PI-AGENT-013: Experiment loops measure, keep, and revert autonomously

An experiment loop runs without further prompts. The agent proposes one change at a time. Flywheel itself runs the measure command on each attempt and the checks after each passing measurement. It records every run and commits only kept attempts that pass checks. It reverts discarded, crashed, or checks-failed attempts. The loop cannot write protected paths or read sealed paths. Every client shows live results with the best kept result and a noise-floor confidence score. Only a user stop, the charter's iteration cap, or a stall from repeated failures ends the loop. It never destroys work outside its working tree.

## PI-AGENT-014: Kept experiments become reviewable branches

When the person runs `/experiment finalize`, Flywheel groups kept experiments into independent changesets that share no files. It proposes the grouping, and after approval creates one clean branch per group from the merge base, so each can be reviewed and merged alone.

## PI-AGENT-015: Workflows resume across compatible method changes

Flywheel resumes a workflow when its graph and execution contracts remain compatible, records changed method content used after resume, and stops before work starts when a structural change makes the recorded run incompatible. The stopped workflow then says that its definition changed and names each changed part once. It says how to continue the work: start a new workflow, or, when the project defines every changed part, restore those parts and press Resume. Resume continues the workflow when its definition matches again, and otherwise names the parts that still differ.

## PI-AGENT-016: Cross-model tool-history continuity

When a conversation continues with a model that has a different tool contract, Flywheel presents prior tool work through the current model's tool surface without changing the durable transcript or teaching an incompatible tool invocation.

## PI-AGENT-017: Shell changes remain inspectable

When an agent declares that a shell command mutates files, Flywheel shows its changes as file tool changes. A created file reads as a write, and a changed or deleted file reads as an edit. While the command's input arrives and while it runs, its row reads as an edit with one line saying a bash command is running, without the command text. When it settles without landed changes, its row reads as the shell command it ran. Changes of a shell command not declared as mutating never show as file writes or edits, and never join the session's changes.

## PI-AGENT-065: A mutating command captures only its own changes

A command declared as mutating captures only its own changes to file contents in the work tree that contains its working directory, never concurrent work by other agents. When a file changed elsewhere while the command ran, Flywheel rebases the command's change onto the current file and marks only the regions that both sides changed as conflicts for the agent to resolve. When Flywheel cannot capture a mutating command's changes, it runs the command in place and says that its changes were not captured.

## PI-AGENT-066: Mutating commands refuse repository and cross-tree changes

Git commands that change the repository run without the mutating declaration, and a mutating command that contains one is refused with a message that says so. A mutating command that writes to another work tree of the same repository is refused with a message that tells the agent to set the working directory to that tree.

## PI-AGENT-067: Long-lived processes run outside mutating commands

A process that a mutating command starts can end when the command ends. On Windows, and on Linux hosts that run the command in its own process namespace, it always ends. A long-lived process, such as a server or a watcher, belongs in a separate command that is not declared as mutating, and such a command keeps the processes it starts.

## PI-AGENT-068: Agent shell writes stay inside the project

Every agent's shell refuses recognized writes and deletes outside the project, the `.flywheel` folders, and the project's registered worktrees, except writes to device sinks. The working directory never widens this allowance, and an unknown working directory does not refuse a write whose literal path lies inside the allowance. A read-only agent, such as the explorer or a reviewer, may write only in its scratchpad or to device sinks. This is a guard against mistakes, not a sandbox for arbitrary programs.

## PI-AGENT-069: A refused shell write tells the agent what to do

A refused write stops the whole command, and the refusal first says that the command was blocked because it is not a safe command. It names the target and the reason, and directs the agent to the project or its scratchpad. When Flywheel cannot place the target, the refusal asks for a literal path. The refusal ends by telling the agent not to rephrase the command to reach the same target.

## PI-AGENT-018: Stalled operations retry at a smaller scope

When a model response stalls while composing an oversized operation, Flywheel redirects its retry to produce a smaller sequential batch instead of retrying the operation unchanged. Normal batching resumes after that model response completes.

## PI-AGENT-019: Subagent budget caps are reported honestly

When a subagent stops at its turn budget, the parent agent and every client see a partial result, distinct from a completed or failed run, so unfinished work is never read as done. The turn budget counts every model request of the dispatch, including requests of runs that recovery started again after a provider fault; only an explicit Resume starts a new budget.

## PI-AGENT-020: A child can be interrupted and resumed

A person, the parent agent, or the runtime can interrupt a running subagent from any surface. Interrupting stops it at once, keeps every result it already committed, and shows on its card who interrupted it, never as failed. Resume continues the child's saved conversation without a new assignment and without running recorded tool calls again. A resumed workflow or subagent counts as its parent's running background work, the same as a newly launched one.

## PI-AGENT-072: Any unfinished subagent can resume under its running parent

Every subagent that has not completed successfully, including partial, failed, stopped, and canceled work, admits explicit Resume from a person or its parent agent. A child resumes only while its parent runs, and resuming opens an idle chat parent without starting its turn. When the parent cannot run, Resume says to resume the parent first, and any other failed Resume says what prevents it.

## PI-AGENT-073: A person's interrupt or stop binds the parent agent

The parent agent never resumes a child that a person interrupted or stopped. A child that a person interrupted continues only when a person resumes it or sends it a message. A child that a person stopped continues only when a person resumes it. Resume availability never recommends resuming or authorizes automatic continuation.

## PI-AGENT-021: Global skill edits need no separate permission

Interactive agents create and change managed global skills without a separate approval. The applied tool result identifies the skill as global.

## PI-AGENT-022: Bash analysis does not depend on warmup

Flywheel makes command analysis ready when an agent uses Bash or exec. Recognized writes and deletes with outside or unplaceable targets are refused before the command runs. If analysis cannot load or complete, including exhaustion of its work or nesting budget, that failure does not block the command. This holds regardless of agent role or available file-editing tools. Flywheel reports the failure without repeated warning noise. Restrictions on commands that Flywheel can identify independently still apply.

## PI-AGENT-023: Output-limit recovery is bounded

When a model response reaches its output limit, Flywheel makes only bounded automatic continuations. If these also reach the limit, Flywheel preserves the received output, stops automatic requests, and shows an actionable output-limit error. A successful response or a new user request starts a fresh recovery allowance.

## PI-AGENT-024: Only the root chat asks the person

Only a chat that no other session started asks the person. A subagent or workflow agent asks its parent with the evidence and waits for the reply only when the design and evidence cannot settle a choice or a missing prerequisite blocks every next action. The parent answers from what it knows, or asks its own parent or its person in its own words, then replies. When no parent can answer now, as in an unattended run with no connected parent chat, the child learns this at once, continues on its own judgment, and states its assumptions in its result.

## PI-AGENT-082: A child never stops as blocked

A child never stops as blocked. A child run ends only as completed, as partial at its turn budget, as stopped or canceled, or as failed. It fails only on a fault that only a person can clear or a fault that repeats on fresh attempts with no progress between them. Interrupted work has not ended and can resume.

## PI-AGENT-083: Agents message other sessions only with a purpose

An agent messages another session only to ask a blocking question its tools cannot answer, answer a question, direct its own child or workflow, or send what its person asked. A root chat can also report a check that fails in a file another root chat owns. Agents send no acknowledgements, thanks, confirmations, status reports, promises of later updates, requests to be told later, "are you done?" checks, or copies of messages the recipient already has. A recipient replies only to a question or a waiting sender, one answer ends the exchange, and silence is not agreement.

## PI-AGENT-084: A session message is complete and sent once

One message carries everything that the recipient needs, opens with what it is about and what the sender needs, and uses complete sentences without a greeting. When a message is held or refused, the agent sends no repeat or reminder and continues its own work. An agent whose reply wait was refused can send the message again without the wait. The person sees every message in the transcript, so an agent does not restate one to its person unless the person asks.

## PI-AGENT-085: A message's authority follows its sender

Each session message names the sender's relation as parent, child, sibling with the same parent, or other. A sender that is neither parent nor child is a peer. A parent's message applies to the recipient's current work at once, and a person's message applies to the agent or address that receives it. A peer message carries no authority. The recipient finishes its current work first and weighs the peer message as information, unless attached words show that the person requested it. An agent never asks a session other than its own child to fix, commit, publish, or revert files.

## PI-AGENT-086: Root chats exchange messages only when needed

A root chat contacts another root chat only when its person asks, it needs a fact only that chat has, or a check fails in that chat's file. It reports such a failure once with the file, check, and exact error. It asks nothing, then treats that file's failures as not its own without waiting for a fix. It answers another root chat's question about commits, publication, integration, or progress once from its state. It answers its person's progress questions from its state and tools. When its person writes, it stops every root-chat exchange that its person did not request.

## PI-AGENT-087: Workflow direction adds to the original request

Each later agent that a workflow message reaches reads the original request and the additions for its address in order. An addition is direction unless it states a change to Design intent. A later addition applies where it conflicts with an earlier addition of the same tier. Recording an addition never replaces the original request, restarts an agent, or starts work on its own.

## PI-AGENT-025: A wait parks only on a child that is the parent's active work

A child that its parent or the runtime interrupted is not active work, so no wait parks on it. A parent that interrupts the child it waits on stops waiting at once. A child that a person interrupted stays the parent's active work, so the parent is not told and its waits park on the child until they expire. A wait expiry never resumes an interrupted session or a question addressed to the person.

## PI-AGENT-080: Managed-work waits receive timed assessments

Every agent wait on managed work, including background commands, services, subagents, and workflows, has a finite duration that the agent sets from its estimate of the remaining work. Without an estimate, a wait lasts at most four minutes. Completion or expiry wakes the agent once without ending the work, and an assessment that finds nothing to act on waits again without writing to the transcript. A wait that a restart or planned replacement cuts continues on the new runtime with its original deadline, without waking the agent.

## PI-AGENT-081: A parent reads its child's progress without waking it

An agent can read the progress of its own child without waking it or sending it a message. A workflow's progress shows the current phase, the agents done out of the planned total, and which agents completed. A subagent's progress shows its state, operations, and tokens.

## PI-AGENT-026: A child hands off only after its background work ends

A subagent or an agent of a workflow hands off only when none of its background work remains. No command that it started still runs, including a server or other service. No subagent or workflow that it started still runs or has a result that has not reached it. It waits for work that finishes on its own and stops a service before it hands off. A handoff that it tries earlier is refused, and the refusal names each item of work. While it waits on its background work, it is still working and never ends because of inactivity.

## PI-AGENT-027: A message to a workflow reaches the agents that it is for

A message to a workflow from its launching parent, or from the person in an agent view, is direction for the agents that it addresses. Without an address it reaches every running and later agent of the workflow, including items whose agents have not started. With an address it reaches only the named items or agents, including an item that has not started and that item's agents in later phases. Each reached agent reads it once, and items outside the address see it only through the join.

## PI-AGENT-078: A workflow message with an invalid address is refused

A workflow message is refused whole, and nothing is kept, when its address names a finished item, an unknown or ambiguous key, or an agent ID that is not valid. The refusal lists the valid keys with their items or agents and their states.

## PI-AGENT-079: A message to one agent stays with that agent

When a message changes an agent's work, the agent records the change in its handoff, quoting the instruction and naming what it replaces. A message to an agent session reaches only that session, including the parent's reply to its question, and adds nothing to the workflow request. Later agents receive that record through their declared outputs, and a message to one agent never becomes direction for its siblings. A peer's message to a workflow reaches only one agent, as information, and never becomes direction for the workflow.

## PI-AGENT-028: Saved definitions load without a restart

A skill or persona definition saved into the project's or account's Flywheel definition folders is available to running sessions without a restart. A definition that an agent saves with its managing tool is available to that agent's next request, and other running sessions see it when Flywheel observes the folder change. A saved definition that cannot load is skipped, sessions keep any earlier version of it that loaded, and other saved changes still load. A definition written for another agent tool also loads when its only fault is an unquoted colon in a frontmatter value.

## PI-AGENT-029: A workflow is phases of agents that run briefs

A workflow file lists phases that run in order. Each phase runs one agent, several named agents at once, or one agent for each item of a list. A phase can follow the phase before it item by item, so each item moves through both phases at its own pace. A phase can run only when an earlier phase completed or an output field is not empty. Otherwise it is skipped, and later phases still run. Each agent's task is its own brief and declared inputs. The request that started the workflow is background that bounds the agent's scope.

## PI-AGENT-103: A repeat runs phases in rounds

A repeat runs its own phases in rounds, one round after another. It repeats while a field of one of its phases is not empty, for at most a stated number of rounds, or once for each item of a list. When a repeat stops at its round bound, or as stuck because a round found the same work as the round before, the workflow still completes. The completion result and notification name each such stop beside the verdict, so a partial result never reads as full.

## PI-AGENT-104: A workflow states its size limits

A workflow file can state an attempt limit of at most 4096, and without one its worst-case attempt count is its limit and must not pass 4096. A launch that queues more attempts than its limit is refused, and the refusal names both counts. A file can also cap how many agents run at one time. A list that an agent writes holds at most 100 items unless the file states another limit, and a list that the launch passes is as long as the agent made it.

## PI-AGENT-105: Briefs live inline in the workflow file

A chat agent writes each agent's brief, its instructions and declared output, inline in the workflow file, and another agent of the same file can reuse it. A brief can compose installed skills but cannot run a skill as its task, and Flywheel ships no briefs. An agent whose brief declares no output hands its summary to the next phase.

## PI-AGENT-106: Workflow agents differ only by brief and persona

Every agent gets the same tools and instructions about how to work, so an agent that must not change files says so in its brief. A workflow can run an agent as a persona, such as a reviewer, and that agent gets everything that a subagent of that persona gets, including its model and limits. Its brief still states its task and its output. An agent can run as, or dispatch, only the personas that the chat can dispatch.

## PI-AGENT-107: A handoff records the commands that it cites

A handoff records each command that it cites with its directory and the exit code of the call that ran, never values that the agent typed. It names each file that changed in the agent's session after that call. A citation of a call that did not run, or a repeated citation, is left out, and the agent is told. A handoff is refused for its citations only when too few real citations remain, and the refusal names the calls that the agent can cite.

## PI-AGENT-108: A workflow agent receives only the context it builds on

An agent receives the output of the phase just before it and the durable outputs. It receives another earlier output only when it names that output in its `reads`, labeled with that id. A workflow is refused before it runs when an agent names an output that cannot finish before that agent starts. An agent sees the file changes made by each earlier agent it builds on, directly or through its subagents and workflows, and never changes by others. It also sees the current state of those files separately, and it is told when a change cannot be shown whole.

## PI-AGENT-109: A plain file read shows the file, not a summary

A plain read of any text file shows the file from its first line, up to 2000 lines, not a summary, and tells the agent where the next read continues.

## PI-AGENT-110: A chat launches a workflow file it saves

A launch by content saves the workflow's text to the session's scratch workflow folder, named by its id and overwriting any same-named file, and launches it. A launch by path from elsewhere launches a copy saved there, so the agent never reads a file only to pass its text. The agent knows the folder's full path, so it can edit and relaunch a saved file. Flywheel offers no launch by name. Before writing a file, the agent can load an authoring reference that teaches only what the installed Flywheel runs. Its examples launch as written, and loading it launches nothing.

## PI-AGENT-111: A launch reports problems and warnings to the agent

A launch refuses a file that is invalid, asks for more than the chat has, or is too large for the launch input. The file stays saved, and nothing starts. The refusal lists every independent problem with its file, phase, agent, or repeat, and key. It tells the agent to load the authoring reference first. Other findings do not stop the workflow and reach only the agent as one short located line. The launch tells the agent each agent's starting model, effort, and persona. The parent's workflow card shows no launch line or warning.

## PI-AGENT-112: A run keeps the file that it launched

In Ask mode, the person approves the file as the question showed it, and an edit after the question needs a new approval. The run keeps the workflow it started with and resumes after the file is deleted or edited, or after a restart, continuing the same agents. Launching an edited file starts a new run.

## PI-AGENT-113: Retired workflow forms still run or stay viewable

A workflow file that names an agent's tools or marks an agent as one that only checks work still runs, and the person is told that those keys do nothing. A file in the grammar from before phases still runs as phases with a warning that the form is retired, and a run that the earlier form started resumes after an upgrade. Past runs of retired named workflows remain viewable, and Resume, Restart, and messages refuse them and name the retired workflow. A stored approval for a retired named workflow cannot approve a file.

## PI-AGENT-114: Parallel agents share one stored prompt

Agents that do not wait on each other run at the same time. When several send the same brief and tools through a provider that stores one shared prompt, the first starts at once and the others start after its first reply, or within 5 seconds. Every agent, also one that runs as a persona, sends the same tools and project-wide instructions, so agents of all phases share that stored part. Through a Claude subscription they share only that part, and through a provider with a separate store per conversation, such as the OpenAI API or ChatGPT, they start together.

## PI-AGENT-115: A failed agent fails its item or its phase

An agent fails after the retries that its workflow states, or after three stops in a row without a handoff despite reminders, with no message or Resume between them. A failed agent of a phase over a list fails only its item, and the join names that item, while any other failed agent fails its phase. A failed phase ends any repeat around it, the later phases do not run, and the run fails once that phase's other agents finish. A run whose phases all ran but that still has a failed item agent also fails.

## PI-AGENT-116: A failed run resumes its failed agents

A failed run tells its parent at once and stays resumable, unless it failed because it could not add or expand work within its limits. A Resume from the person or the parent runs the failed agents again with the agents that wait on them, and every other finished agent keeps its result. When an item agent runs again, its list's join folds again, and each later phase that reads that join runs again in full over what it reads now. Each client offers this Resume where it offers an interrupted run's Resume, and the failed run takes no message.

## PI-AGENT-117: The completion result gives the parent every agent's result

The completion gives the parent each agent's result in workflow order, labeled by phase or agent id and item. It names each agent that failed, was skipped, or did not run. A finished agent's result is its handoff with its recorded commands and their results. Each join's output appears too. The results share one size limit, which the latest results take first. The completion names each result that did not fit and how to read it. Each failed agent appears with its reason, and the card shows it as failed. The completion says that a Resume reruns the failed agents.

## PI-AGENT-118: An unattended agent recovers from provider faults on its own

A workflow agent, subagent, or headless task recovers from provider faults alone, waits while its model's access is checked, and never asks the person to act. A fault that only a person can fix, such as a rejected request, an unconfigured model, or an unrepairable content refusal, ends the agent at once. When a fault can clear, such as a stall, dropped connection, overload, unexplained failure, or stopped engine, the agent continues its recorded conversation on a fresh attempt after a growing pause. The agent fails only after six fresh attempts in a row fail without a served request.

## PI-AGENT-030: Headless chat uses standard input and output

Headless chat behaves like interactive chat, with standard input and output replacing the graphical or terminal client. It uses the same instructions, tools, conversation history, child agents, workflow supervision, authentication profile, and provider admission and failover. It adds no provider filter, billing ceiling, or usage pause to the profile's normal policy. A versioned JSONL channel accepts messages, question answers or cancellations, interrupts, and stops, and streams responses and state changes.

## PI-AGENT-074: Headless chat ends when its owned work ends

Open input permits more turns, and closing input lets submitted work finish. In one-shot mode, the agent's final reply is its result, and the agent writes it once. A turn that ends while work the agent owns still runs waits for that work. Otherwise the run completes and returns the final reply without an exit command or closed input, and the session stays available for resume.

## PI-AGENT-075: Headless questions wait for the caller

A question waits until the caller answers or cancels it, and headless chat never invents approval. A run that ends with an open question reports input required, not approval or success.

## PI-AGENT-076: Headless runs show settings and evidence

A caller can inspect resolved settings without making a model request. Run evidence identifies actual provider attempts and child activity and distinguishes estimated equivalent value, billed cost, and unavailable accounting.

## PI-AGENT-077: Headless automation runs as a chat or a direct task

Headless automation runs as a headless chat or as a direct task. The headless workflow command refuses and names both as its replacements.

## PI-AGENT-031: Chat orchestrates substantive work with workflows

While Workflows is On, the root chat agent delegates every substantive task and works directly only on conversational turns and trivial mechanical edits. It aims for the most complete and correct result, not the cheapest one, and reaches it as soon as possible. While Workflows is Ask, the agent launches only when its judgment says the task needs a workflow, and each launch needs the person's approval. While Workflows is Off, no workflow can launch, and the chat works directly or through subagents.

## PI-AGENT-056: Chat sizes each delegation to its work

The root chat uses a workflow only when at least two agents are needed and a later agent reads an earlier agent's output. It gives one agent's work to a subagent and independent work to parallel subagents. It prefers workflows that verify findings adversarially, unless the work is trivial or already verified.

## PI-AGENT-057: Delegated work runs one part at a time

Work in several parts, such as understand, design, and implement, runs as separate dispatches in sequence. The chat reads the result of each part before it starts the next part. A part holds all of its own agents, so build, review, repair, and the verification of the repair run as one workflow.

## PI-AGENT-058: Independent units of work run at the same time

Independent units of work start at the same time. A unit waits only for a named prerequisite or for a file that a running unit changes. The order in which units commit does not make a unit wait.

## PI-AGENT-032: Tool calls are read for what they mean

Flywheel carries out a tool call whose meaning is clear even when its form is wrong. Examples are a value in the wrong type or encoding, a misspelled key or option, a wrapped argument object, or another form of a path to exactly one existing file. The result begins with a note that states how Flywheel read the call. Flywheel never changes an already valid value, invents missing content, or chooses between two meanings. It never relaxes a safety, permission, or containment check. It refuses a call that needs any of these, with what the agent needs to correct it.

## PI-AGENT-033: Every finished background task reaches its parent

When a subagent, workflow, or background command ends, its result reaches the conversation of the agent that started it. This holds after contention, a restart, a planned replacement, or a stop, and while that agent is mid-turn or waiting. Until it arrives, it counts as that agent's outstanding work.

## PI-AGENT-034: Each model request is inspectable

A person can inspect which context sources each model request used and what each one contributed. When a source's content was not kept, inspection shows its identity. Inspection also shows what was left out, cut short, summarized, compacted, or withheld, and why. It shows which request, agent, or subagent produced later work. It says which evidence is exact and names each part not kept, instead of presenting a guess as exact. Each retry and each fallback to another provider appears as its own request.

## PI-AGENT-035: Subagent results are condensed and cited

A subagent takes bounded, noisy work off its parent, such as locating definitions, tracing a flow, inspecting logs, reviewing, summarizing a large artifact, or running an isolated experiment. The parent receives a condensed result, not every intermediate message. The result cites evidence that recovers detail, such as file paths with line numbers, artifact or event IDs, URLs, or session IDs. A result that exceeds the parent's share of its remaining context is cut to fit. The parent reads which parts were cut and where the full result is kept. The subagent row still shows the first sentence of its summary.

## PI-AGENT-036: Outcomes explain themselves

When Flywheel reports autonomous work as done, blocked, failed, superseded, or overridden, it shows a concise explanation linked to the evidence. The explanation shows how the outcome follows from the target and evidence, so the person never reads raw history to learn why. The explanation can compress evidence but always names each criterion that is missing, failed, superseded, or overridden, and who overrode it.

## PI-AGENT-037: Instruction files stack from global to the working directory

Every agent turn follows the person's global instruction file first, then the repository's instruction files from the repository root down to the agent's working directory. The more specific file takes precedence. Each section names where it came from, and a file that an instruction file names with @ is included as its own section. Edits to memory and instruction files take effect at the person's next message in a chat, and when a workflow agent or subagent starts. Instruction files below the working directory do not load, and an agent reads the governing file before it changes files there.

## PI-AGENT-064: Linked instruction files stay inside trusted places

A linked instruction file is read only when its target stays inside the project or the person's home and outside Flywheel's own data.

## PI-AGENT-038: Skills are for agents and commands are for people

Skills are methods that agents load. A person never runs a skill directly: no command list, palette, completion, or typed slash token offers one. Every action a person starts is a slash command, and a command that needs a method starts it as the chat's next turn.

## PI-AGENT-039: Learning has project or global scope

Every memory entry and learned skill applies either to the current project or to all of the user's projects. Learning that agents save on their own applies to the project unless it clearly concerns the user everywhere, and a background learning review may end without saving anything. A background review never changes a global skill; it recommends a promotion that the user decides. Promoting a skill moves it to global scope, so it no longer exists as a separate project skill.

## PI-AGENT-040: Learned skills never duplicate or change built-in skills

Flywheel saves a skill it learns on its own only when an independent check approves it. The check approves a skill that neither duplicates nor contradicts a built-in skill, or that correctly narrows one. If the check fails or is unclear, nothing is saved. Flywheel recoverably archives learned project skills that conflict with built-in skills, and keeps unclear cases. Learning never changes or suggests changes to built-in skills. An installed skill that shares a built-in skill's name is used instead of it, and the built-in skill stays unchanged.

## PI-AGENT-041: A spent workflow budget pauses before the next attempt

A workflow's configured budget limits its attempts, tokens, and wall-clock time since launch, and a chat has no workflow budget. The token limit counts only provider-reported tokens of the workflow's own agents and auxiliary usage, not of their subagents. Flywheel checks the budget only before an attempt starts, so running agents finish and the next start is refused, which pauses the workflow. The pause reason names how many requests the run made without a usage report, and a Resume while the budget is spent is refused before anything continues.

## PI-AGENT-042: Repeated restarts without progress pause a workflow

After a host crash or restart, each running agent of a workflow continues in its conversation. An agent that crashes again after three restarts without progress is not restarted a fourth time: the workflow pauses. Any recorded progress starts the count over.

## PI-AGENT-043: Workflow verification checks without running

`flywheel workflow verify` checks a workflow file or a past run with the same rules that launch and execution use, and reports proved, partially proved, or invalid, with its uncertainties and the examples that prove each result. It never runs an agent and writes nothing. For a past run, it prints every phase, agent, and join of the run, with each join's kept and dropped entries and the records that the run left out of agent context with their reasons. When the run's history cannot be read back, it prints the reason instead of a guessed structure.

## PI-AGENT-044: Subagents nest at most three deep

Subagents can dispatch their own subagents, at most three deep below the chat or workflow agent that started the chain, and a deeper dispatch is refused with the reason. A dispatch is never refused for its rate or count, but subagents beyond the running limit wait in a queue and start in dispatch order. Persona grants decide which child types an agent can dispatch. On trial since 2026-11-01, every agent of a workflow can also dispatch the advisor without a grant, except an agent that itself runs as the advisor.

## PI-AGENT-045: Large unused session scratch is reclaimed

Each session's scratch folder is disposable. Flywheel removes a top-level scratch entry larger than 100 MB after three days without a write, and removes a linked Git worktree there through its repository, so the repository no longer lists it.

## PI-AGENT-046: Agents work without per-call approval

Flywheel never asks the person to approve an individual tool call or command; the one exception is workflow launch approval while Workflows is Ask (PI-AGENT-031). Flywheel's command guards prevent ordinary mistakes but do not confine the programs that an agent runs (PI-AGENT-068). A person who needs confinement runs Flywheel inside a boundary such as a virtual machine, a container, a low-privilege account, or a disposable checkout.

## PI-AGENT-047: Processes that outlive Flywheel need explicit permission

Agent commands that keep running after Flywheel exits are off by default. A person turns them on in the configuration or for one launch with a command-line flag, and an agent must then ask for survival on each background command that it starts. The agent can list such a process, read its output, and stop it only while Flywheel runs. A command that is declared to change files cannot also keep running after Flywheel exits.

## PI-AGENT-048: Agent commands find the person's own programs

On macOS and Linux, an agent's shell commands find the same programs as the person's login shell, including the search programs that Flywheel bounds, whether Flywheel started from a terminal or as a background service. Until Flywheel knows the login shell's PATH, or when it cannot read it, commands use Flywheel's own PATH. On Windows, commands use Flywheel's own PATH.

## PI-AGENT-053: Agent searches stop when they grow too broad

An agent's search and list tool calls stop after 30 processor seconds, or 120 seconds waiting on reads, and tell the agent to narrow the search. On macOS and Linux, the shell programs `grep`, `egrep`, `fgrep`, `rg`, `find`, `fd`, and `du` that agents run get the same processor limit and advice, except `find` or `fd` running a per-result command. Searches other than `du` never report or delete anything inside artifact directories, such as `node_modules`, `.git`, and the project state directory, or inside ignored directories, unless the call names one. The shell programs otherwise keep their own arguments, matching, and output.

## PI-AGENT-049: Agent file changes keep what they did not change

A file change by an agent tool keeps every byte it did not change. Text decodes as strict UTF-8. An existing byte-order mark and existing line endings stay exact. A new line ending follows the replaced line ending, then the nearest local style, then the file style. An update, overwrite, or move keeps the file's existing permissions without widening them. A project file or directory that a tool creates gets the permissions that the person's own tools would give it.

## PI-AGENT-050: Skills install by link

A person can install a skill by linking its directory into a skill folder. The linked skill loads under the link's name and follows every edit to its source. Flywheel never changes the source through the link.

## PI-AGENT-051: Installed skills keep their own descriptions

Installed skills keep their own descriptions. A skill that a person installs from outside Flywheel reaches agents with its whole description as its author wrote it. Flywheel never shortens it. A person makes the skill list smaller by uninstalling skills.

## PI-AGENT-052: A command that waits for processor time says so

A held command shows that it waits for processor time and keeps its output. The time that a held command waits does not count against its timeout. When a held command reaches the foreground limit, the agent learns that it waits for processor time and how many commands are ahead of it.

## PI-AGENT-063: Commands that need more processor time than the machine has wait their turn

When agent commands need more processor time than the machine has, Flywheel runs as many as its processor budget serves and holds the rest, so they finish in turn instead of all slowing together. The budget is the machine's logical core count of ready-to-run threads from Flywheel's own commands, and other programs on the machine do not reduce it. A held command resumes oldest first when the budget frees, and a command that rarely has work ready to run never waits. A command that a chat's own turn starts is never held, and its demand counts toward the budget.
