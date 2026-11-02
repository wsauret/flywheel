/** Wire compatibility and event-lane liveness policy shared by every runtime serving and client placement.
 *  Version 9: interrupt is the one resumable cut. Chat and workflow rows admit `chat.interrupt`,
 *  `chat.resume`, `workflow.interrupt`, and `workflow.resume`, a child row admits
 *  `subagent.interrupt` and `subagent.resume`, and a child's or model-launched workflow's row
 *  admits Stop as `background.terminate` on the `parentToolUseId` it carries.
 *  Version 10: status settlement barriers also carry opaque recovery requirements
 *  when final output has not yet been covered by the public output sequence.
 *  Version 11: an output delta changes live streaming tool text through keyed
 *  `streamingToolTextOps` (set, remove, or edits against the version last
 *  shipped) instead of `streamingToolTextAppends` and whole-map replaces, and a
 *  subagent card's children are compact rows without their bodies.
 *  Version 12: the `executor` workspace domain and the snapshot's `executor`
 *  field state what a person should know about the process that runs the
 *  project's sessions, and a refused workflow interrupt carries its reason.
 *  Version 13: the `service` workspace domain and the snapshot's `service`
 *  field state what a person should know about the account service that
 *  serves the project.
 *  Version 14: the update view's `refused` status names a release that a
 *  rollback refused while the account runs an older one.
 *  Version 15: the update view's `refused` status names the refused build by
 *  its build identity when it has the running build's version, and its
 *  `source-refused` status names the source that a dev service could not
 *  start and the proved snapshot of its checkout that it runs in its place.
 *  Version 16: the snapshot's `runtimeBuildId` names the code identity of the
 *  connected runtime process, or null when it cannot be known.
 *  Version 17: degraded transcript blocks admit the `agent_input` fact family.
 *  Version 18: authenticated project attaches carry transient `serve.startup.phase`
 *  records before ready. Starting and ready retain their shapes; older readers
 *  cannot consume phase frames, so the serving version must match.
 *  Version 19: tool rows carry `declaresEdits`, which alone makes a shell
 *  command an edit card; an older runtime never sets it, so a newer client
 *  would show its shell edits as commands.
 *  Version 20: ordered held session detail and workflow child admission.
 *  Version 21: `session_detail.release` lets go of a read detail apart from
 *  the activation; an older runtime would pass it to its executor.
 *  Version 22: a `workflow.launch` result and `launch.published` name the
 *  parent chat beside the child, so a client can show the chat that a launch
 *  with no origin created; an older runtime never names it.
 *  Version 23: a chat catalog row admits only chat actions and carries no
 *  workflow state, and a workflow view carries no runtime phase; an older
 *  runtime could send both.
 *  Version 24: the runtime serves a call that follows an event subscription
 *  on one connection only after that subscription is registered, so a
 *  client writes its reads beside the subscription; `runtime.connected`
 *  carries no position and no diagnostics flag; and a client reports one
 *  `lane_attach` timing record for each lane. An older runtime could serve
 *  such a read before the subscription and lose a change. An output delta
 *  changes a block the clients hold by an `edit` against the copy last
 *  shipped, and never carries the whole streaming tool-text map; an older
 *  client rejects the edit.
 *  Version 25: a message row from another session carries `from`, the
 *  sender's id, name, and relation and the words of the person it attached.
 *  An older client would show the message as the person's own.
 *  Version 26: one `session.send` takes a person's message to a chat, a
 *  subagent, or a workflow, in place of the chat send and the two child
 *  steer requests; a child row's input mode is `message` and its admitted
 *  message action is `session.send`; and a status carries `replyWaits`, the
 *  sessions it waits on for a reply. An older peer sends or reads the
 *  retired names.
 *  Version 27: the session domain `background` carries one invalidation
 *  patch, and the `sessionBackgroundWork` query answers the background
 *  index of a chat. An older peer rejects the patch and the query.
 *  Version 28: a workflow view shows the steps its workflow can still reach,
 *  and a step that runs only if an earlier step's handoff asks for it has the
 *  status `conditional`. An older client rejects the status.
 *  Version 29: the command catalog lists only the built-in commands that run
 *  now, and carries `offCommands`, the commands that only a turned-off module
 *  provides. An older peer reads or sends the retired `available` flag.
 *  Version 30: MCP rows carry applied scope, enabled state, fallback and opaque
 *  expectations; lossless MCP enabled/removal mutations report saved warnings.
 *  Config write failures distinguish definite non-application from unknown outcome.
 *  Version 31: a turn end and a run row can name `agent` as the actor of an
 *  interrupt, when a parent agent interrupts its own child. An older client
 *  rejects the actor.
 *  Version 32: the module vocabulary no longer names
 *  `provider-claude-subscription`, a binary module setting carries no
 *  `riskWarning`, and `settings.set_module` carries no `riskAcknowledged`. An
 *  older peer names the retired module or sends the retired field.
 *  Version 33: a workflow definition change names a `step` with the `aspect`
 *  that changed, in place of the retired `binding` and `registry` components.
 *  An older client rejects the component.
 *  Version 34: a workflow view step and an assignable step seat name their
 *  model seat by `contentId` in place of `skillId`. An older peer reads or
 *  sends the retired field.
 *  Version 35: an auth account carries its `plan` and an `attention` that
 *  names a refused login or an exited program, and a provider's `attention`
 *  can name a missing or unsupported program. An older client rejects the
 *  new attention kinds.
 *  Version 37: an auth provider names the `loginProgram` that owns an
 *  external login, in place of the retired `accountLabels`. An older peer
 *  reads or sends the retired field.
 *  Version 38: a provider's `attention` names only malformed stored data;
 *  the retired missing-program and unsupported-program kinds are gone, because
 *  Flywheel ships the engine that its external login runs. An older runtime
 *  can send a retired kind, which a newer client rejects.
 *  Version 39: a workflow transcript holds a `workflowRoster` block for the
 *  agents of a map or of a concurrent phase, a workflow view can carry the
 *  workflow's `tree`, an agent-specific output query reads the transcript
 *  of one agent of a roster, and the received-input query reads the
 *  handoff that agent received. An older client rejects the block and the
 *  queries.
 *  Version 40: `session.send` can carry `targets`, the lanes or steps of a
 *  workflow that an agent view's composer addresses. An older runtime
 *  rejects the field.
 *  Version 41: a workflow tree's join coverage names the required targets
 *  that the survey did not reach as `unsurveyed`, in place of `missing`,
 *  and a coverage join fills it. An older client rejects the field.
 *  Version 42: a workflow tree's join can carry `selection`, the kept and
 *  dropped counts of a dedupe, top, or quorum join. An older client rejects
 *  the field.
 *  Version 43: a workflow view can carry `launch`, the definition source,
 *  the verifier result, and the worst-case attempt count that its launch
 *  recorded, and a workflow card can carry the same words as `launch`. An
 *  older client drops both fields and shows no launch line.
 *  Version 44: the `workflowAgentReceived` query answers `handoffs`, every
 *  handoff that the agent received, which holds each output that its step
 *  reads beside the handoff of the step before it, in place of `handoff`.
 *  An older client rejects the answer.
 *  Version 45: a workflow tree can hold a `rounds` node, which is a loop
 *  over a map, and the group of each of its rounds carries `round`, its
 *  number and how it ended. An older client rejects the kind and the
 *  field.
 *  Version 46: a workflow view's `launch` can carry the verifier result
 *  `invalid` and `warnings`, what the launch of a workflow file warned
 *  about, because a launch runs a file that the verifier did not prove. An
 *  older client rejects the value and the field.
 *  Version 47: a `workflowRoster` block carries `live` as a list, one entry
 *  for each agent of the roster that runs now, because the agents of a
 *  roster run at the same time. An older client rejects the list.
 *  Version 48: an account's auth attention can carry the kind
 *  `program-cannot-start`, an engine that cannot start on this machine. An
 *  older client rejects the kind.
 *  Version 49: the module vocabulary names `adhoc-workflows`, the Ad hoc
 *  workflows add-on of Workflows. An older client rejects the id.
 *  Version 50: a workflow tree's group carries `mapId` and `stageIds`, the
 *  short ids that the step strip names a map and its steps by. A workflow
 *  view carries no `launch`, and a workflow card carries `warnings`, each
 *  warning of its launch, in place of its `launch` line. The
 *  `workflowAgentReceived` query is gone: an agent's transcript opens with
 *  the prompt that the agent received. An older client rejects the new
 *  fields.
 *  Version 51: shell rows carry `declaresMutation` in place of
 *  `declaresEdits`, and compact child rows retain `mutationChanges` after
 *  their diff bodies are omitted. An older peer reads or sends the retired field.
 *  Version 52: a workflow card carries `outline`, the bounded outline of
 *  its plan that its card draws, in place of `progress`, and carries no
 *  tool rows of the workflow. An older client rejects the field.
 *  Version 53: the role group `steps` is `briefs`, the role `step-agent` is
 *  `workflow-agent`, and a workflow seat is `brief.<briefId>`,
 *  `brief.<briefId>.persona.<role>`, or `brief.<briefId>.at.<definitionId>`
 *  in place of `step.<contentId>`, `.agent.`, and `.at.<stepId>`. The
 *  runtime config carries `workflow.max_attempts` in place of
 *  `workflow.max_steps`. An older client rejects the group and misses the
 *  seats.
 *  Version 54: a workflow tree holds phases, agents, and repeats, and each
 *  phase of a stream is a phase of its own. A workflow view carries
 *  `attempts` and `attemptsStatus` in place of `steps` and `stepsStatus`,
 *  each attempt names its `definitionId` and `briefId`, and a workflow card
 *  entry is `single`, `parallel`, or `list`. A transcript names a divider
 *  `divider` in place of `stepBoundary`. A `workflow.launch` carries
 *  `agents` in place of `steps`, the command catalog carries
 *  `assignableBriefs` with each `briefId`, a definition change names an
 *  agent record `agent` in place of `step`, and execution evidence names
 *  the workflow attempt of a request `workflowAttemptId`. An older peer
 *  rejects the new shapes.
 *  Version 55: a workflow card carries `card`, the bounded fold of its plan
 *  in phases with their agents as a tree, their units by state, and the
 *  counted rest, in place of `outline`, and may carry the workflow's name
 *  as its `label`. The session domain `workflow_live` and its query
 *  `workflowLiveSnapshot` carry the live state of every running or
 *  interrupted agent, which a `workflowRoster` block no longer carries as
 *  `live`. A workflow attempt names the `persona` of its agent record. An
 *  older peer rejects the new shapes.
 *  Version 56: a workflow has no transcript. The `workflowRoster` block
 *  kind is gone, and `outputWindow` and `outputRange` answer a workflow
 *  session with an unavailable range. The agent-specific output query names
 *  its `target`: an attempt, or the follow-up conversation, which a workflow
 *  view marks as `followUp`. The mutation
 *  `workflow.restart` and the admitted action of the same name run a
 *  workflow whose saved progress is damaged again from its recorded
 *  request, in place of the `explicit-message-required` refusal of a
 *  Resume. An older peer rejects the new shapes.
 *  Version 57: a workflow card's phase of named agents that has not
 *  started lists its agents as `agentNames` in place of a `detail`, and a
 *  workflow view's `name` is the run's name: the title that its launch gave
 *  it, or its workflow's name when the launch gave none. An older peer
 *  rejects the new shapes.
 *  Version 58: clients no longer launch workflows directly. The
 *  `workflow.launch` and `workflow.slash_launch` operations and their launch
 *  results are gone. The command catalog no longer carries workflows or
 *  assignable briefs.
 *  Version 59: the module vocabulary no longer names `adhoc-workflows`.
 *  Workflows alone governs workflows that agents write. An older peer that
 *  names the retired id is refused.
 *  Version 61: clients report coalesced background-read failure episodes through
 *  the `background_read` diagnostic. An older runtime rejects this diagnostic.
 *  Version 62: transcript recovery accepts exact resident-span anchors and
 *  returns authoritative block membership. An older runtime rejects the anchor.
 *  Version 63: the background index lists a workflow as one row with its
 *  `progress` and no row for each of its agents. A newer client rejects the
 *  `workflow-agent` rows of an older runtime.
 *  Version 64: every client states its `protocolVersion` at each event
 *  attach, and the runtime refuses another version, or none, with the
 *  `protocol-mismatch` error kind, whose `runtime` names the release and
 *  protocol version the runtime serves. The attach ignores fields it does
 *  not know, so this refusal reaches a client of any later version. An older
 *  runtime rejects the attach.
 *  Version 66: roles snapshots and patches carry an assignments map plus the
 *  runtime-resolved serving seat. Older clients read a plain role map and
 *  cannot identify the session-local picker target.
 *  Version 67: a `session.send` whose submission the runtime already holds
 *  answers `ok` with that submission in `confirmedSubmissionIds` and records
 *  nothing, so a client sends again by itself a message whose answer its
 *  connection lost. An older runtime records such a copy a second time.
 *  Version 68: model roles no longer carry the `briefs` group. The Workflow
 *  Agent role belongs to `agents`. An older peer accepts the retired group.
 *  Version 69: project notification episodes can omit their action. An older
 *  client rejects a snapshot or patch that contains an actionless episode.
 *  Version 70: a `chat.open` may name its chat by `sessionId`. The runtime
 *  opens that chat once and answers a copy with the chat that exists, so a
 *  client sends again by itself an open whose answer its connection lost.
 *  An older runtime opens a second chat for such a copy.
 *  Version 72: composer-return claims require the sending client's submission
 *  IDs. An older runtime can give the text to another attached client.
 *  Version 73: paid-use modes no longer carry `canEnable`, and unavailable
 *  settings carry a settings-read failure message instead of a usage failure.
 *  Older clients reject these auth views.
 *  Version 74: `workflow_live` patches are `workflow_live.changed` changes
 *  that carry only the agents that moved, in place of whole
 *  `workflow_live.updated` views. Each version's decoder drops the other's
 *  patch, so a workflow card of an older client would stop moving.
 *  Version 75: `output.watch` states the sessions whose live output a
 *  connection follows; the runtime sends output deltas only for those, so
 *  an older client would see every transcript stop moving.
 *  Version 76: the streamed character count moves from status to output
 *  deltas and reads, so status patches carry only what every client shows.
 *  An older client would decode no status.
 *  Version 77: a runtime fault states its automatic report as one `report`
 *  outcome, sent, failed, or not sent from a build that is not a release, in
 *  place of separate report fields. An older client would show no report
 *  outcome.
 *  Version 78: a `mutationFiles` query may ask for `previews`, and its page
 *  then carries each retained file's collapsed preview text, so a collapsed
 *  diff has its final height without patch reads. An older runtime rejects
 *  the query.
 *  Version 79: a status carries `processorHeldToolCallIds`, the shell
 *  commands that processor admission holds. A client of this version would
 *  decode no status from an older runtime.
 *  Version 80: a workflow's live view holds every agent that started, each
 *  with the active time of its session, and a workflow's detail carries the
 *  intervals in which its run was active, so every client counts only active
 *  time for an agent and a phase. An older client reads a settled agent as
 *  one that runs.
 *  Version 81: an update status may be `no-repository`, for a build that
 *  names no release repository and so never updates itself. An older client
 *  would decode no update view from such a runtime.
 *  Version 82: a session's change review covers the sessions it launched,
 *  and each changed file names the launched sessions that changed it in
 *  `writers`. An older client would decode no review from such a runtime.
 *  Version 83: a model option names each provider with its full name, its
 *  short name, and whether it would serve now, and no longer names the
 *  model's API family. An older client would decode no model options from
 *  such a runtime.
 *  Version 84: the command catalog carries no skill commands and the
 *  `inline.invoke` mutation is gone, because skills are agent methods that
 *  no person types. An older client would decode no command catalog from
 *  such a runtime.
 */
export const RUNTIME_PROTOCOL_VERSION = 84

export const RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS = 5_000

/** How long a client waits without a frame before it treats the lane as dead.
 *  The heartbeat rides the same ordered lane as the data, so on a slow link a
 *  burst of output queued ahead of it delays it by however long that burst
 *  takes to drain; the deadline must outlast any such burst, or a healthy lane
 *  under load reconnects from scratch. A wedged lane is still caught, a minute
 *  later at most. */
const RUNTIME_EVENT_SILENCE_DEADLINE_MS = RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS * 12

export interface RuntimeLivenessPolicy {
  readonly heartbeatIntervalMs: number
  readonly silenceDeadlineMs: number
}

/** The production timing pair. Hosts and clients share it by default; tests
 *  can supply the same relationship at a shorter scale without waiting for a
 *  real minute to prove that recurring heartbeats keep an idle lane alive. */
export const RUNTIME_LIVENESS_POLICY: RuntimeLivenessPolicy = {
  heartbeatIntervalMs: RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS,
  silenceDeadlineMs: RUNTIME_EVENT_SILENCE_DEADLINE_MS,
}
