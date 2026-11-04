# Records by Symptom

Each entry names the records that explain one symptom and the fields to read. Records hold metadata, never content.

## Content refusal

For a run that recovered from a provider's content refusal, or ended with it, search `log.info` for `content refusal repair` and the session id. Each refusal that the agent loop handles writes one record with `decision` (`withhold`, `remove`, or `unrepaired`), `accessProvider`, `located`, and, when present, `partKind` and `removedCalls`. The decision, with its note, is a system message that carries `contentRepair` in a `chat.entries.appended` fact: `flywheel events search --session <sessionId> --type chat.entries.appended contentRepair`.

## Unattended recovery

For an unattended run that recovered from a provider fault, or ended with one: `flywheel events search --session <sessionId> --type agent.unattended.recovery`. The unattended recovery policy (`src/orchestration/agent-runtime/unattended-recovery.ts`, ARCH-RUNTIME-003) writes one INFO record for each decision on a failed run of a workflow agent, a subagent child, or a headless task:

- `caller`: `workflow-agent`, `subagent`, or `headless`.
- `runId`: the attempt id, the child run id, or the headless conversation id. It also names the run's wait notice scope, `unattended:wait:<runId>`.
- `decision`: `wait` for a capacity wait or a model-access wait, which does not count as an attempt; `restart` for a fresh attempt after the pause in `delayMs`; `interrupted` when an interrupt ended a wait; `fail` when the failure stands.
- `failure`: the failure kind of the failed run, such as `api_error`, `stream_stalled`, or `model_unavailable`.
- `streak`: the count of fresh attempts in a row with no served model request.
- `served`: the model requests that the failed run served.
- `delayMs`: the length of a pause or of a capacity wait. A model-access wait has none.

To read a streak, follow one `runId` in time order. Each `restart` adds one to `streak`, and its `delayMs` doubles from 5000 to 160000. A record whose `served` is above zero starts the count over, so its `streak` is 1 again for a `restart`. A `fail` with `streak` 7 means that the fault repeated on six fresh attempts in a row and none served a request. A `fail` with a lower `streak` names a fault that needs a person, such as an `api_error` that the provider rejected, a refused login, or a `context_overflow`; for a workflow agent, an overflow after tool calls continues in a fresh conversation (ARCH-SESSIONS-012). A run that restarts again and again with `served` above zero on each record makes progress between faults, and the policy sets no bound on that shape, so investigate the fault itself. A crash restart of a workflow is a different counter: the host pauses the run with the `attempt.resume_cap_exceeded` fact when an attempt restarts a fourth time with no progress.

## Claude engine step gate

For a Claude engine request that the step gate refused, search `provider.claude_sdk.query.stopped` with `reason` `step-gate`. Its `evidence` holds `asks`, the steps that the gate answered before the fault, `rejected`, the count of bodies that the gate could not read, and `socketPathBytes`, the length of the gate's socket path. A `gate-unreachable` stop with `retry: "fresh-engine"` sent the same unread request once more on a fresh engine; a second `gate-unreachable` stop for that request, without `retry`, ended it with the step-gate error, which an unattended run does not retry. Each body that the gate cannot read also writes `provider.claude_sdk.step_gate.rejected` with its byte length as `bytes`; that family is DEBUG.

## Terminal rendering failure

Search `log.error` for `transcript projection failed` and the session id. The record holds the error stack, the last flush reason, bounded recent update coordinates with published-window counts, origins, and publication modes, and source-store and rendered-window hole and undefined-slot indexes. The last flush reason names the most recent flush, not an active flush phase. The root `renderer failed` record captures errors outside transcript projection. Successful updates write no records.

## Vanished transcript row

Search `log.info` for `transcript delta diverged from the resident window` or `retained transcript became empty` and the session id.

- Divergence records identify the rejected operation index, kind, and reason. Block rejections include the applicable absolute and local indexes, expected and incoming identities, or content offsets and lengths. Streaming rejections identify the tool use and the rejected edit index and kind, without edit paths or values. `detail.cursor` holds the applied, incoming, and incoming predecessor output positions; `detail.resident` describes the original window, while rejection coordinates describe the draft at rejection. `detail.delta` gives operation counts and the requested truncation. `detail.nearby` samples at most eight original nearby block identities.
- The empty record fires once when a retained session publishes a nonempty to empty transition. `before` and `after` describe published coordinates, counts, status, generation, and seed epoch; `source` describes the store at publication. Samples hold at most eight block identities, plus at most eight submission ids per user message, their total count, pending and injected flags, and image count.
- Both terminal records include the resident's last 32 `recentUpdates`, with at most eight replacement indexes per update, to tell pending, deferred, and completed publication apart. The last flush reason is historical, not an active phase. These records explain observed state and rejection, not the cause of message loss. Initial and repeated empty publications and healthy updates add no records.
- Search `transcript rendered no blocks for a session with output` and the session id, in the terminal log and the web client's diagnostics alike. The shared transcript store writes it when a read (`source: "read"`, an install, merge, or around window with its drained patches) or a live patch (`source: "patch"`) leaves the window with no blocks while `totalBlocks` or `visibleMessageCount` is above zero. It holds `status`, the intake's `heldPosition` and `pendingCount`, `totalBlocks`, and `visibleMessageCount`. It records once per episode, however long the pane stays empty; later empty renders count, and `transcript rendered no blocks again` reports the `count` when blocks return or the store closes.

## Every session reports an unexpected exit

The project's executor process ended. The account log under `~/.flywheel/log/` records `executor process exited unexpectedly` for every executor exit except one that answers a requested Stop. An exit by a stop signal while a requested Stop still waits also answers that Stop, because the executor ends by its stop signal only after its own stop settled or its lifecycle channel detached; for that exit the account records `executor ended by its stop signal during the account's stop` at INFO, with the `executorPid`, the `signal`, the `termination` when the exit names a decision, and `stopWaitedMs`. Unexpected exits include a death during startup and an end that Flywheel made itself, such as the end of an executor that stopped answering. Fields:

- `projectId` and `generation`: the executor generation that ended.
- `executorPid`: the executor's own pid, which names its log files. It is absent when the executor exited before it reported its pid.
- `supervisorPid`: the pid of the command supervisor that led the executor's container.
- `lifetimeMs`: the time from launch to exit.
- `code` or `signal`: the exit status.
- `statusOf`: `payload` when the command supervisor reported the executor's own status, or `supervisor` when the supervisor died while its container still ran and the launcher ended the container; then the code or signal is the supervisor's own death. A signal that ends the whole container at once reads as `payload`.
- `termination`: the decision Flywheel made to end the executor, when there is one.
  - When the account ended the generation itself before the exit: the account's pid (`senderPid`), the `container`, and the cause as `reason` with its `detail`.
  - When the process guardian that held the executor's container exited, and the account's stop of the executor is not under way, the account decides the end at the kernel's report of that exit, before the supervisor ends the container: `reason` is `lost its process guardian`, and `detail.guardian` holds the `guardianPid`, its exit `code` or `signal`, and the `channel` reason when the guardian's control channel failed first. The supervisor's `stop requested` that follows only carries that decision out.
  - When the account had already read the command supervisor's own guardian proof, that proof is the `termination`, and the account decides nothing. During the account's stop the account also decides nothing: the executor joins its running stop at the stop word's signal, and that exit ends the stop with the INFO record above.
  - Otherwise, the last decision Flywheel recorded to signal the executor's container before the exit: the deciding process (`senderPid`), the `container`, the `target` the signal reached, the `signal`, the `reason`, the `evidence` the trigger rested on, and the `caller` stack of the code that decided. The supervisor's `reason` names its trigger: `controller channel ended`, `stop requested` for a controller's stop word, `stop signal received` with the `signal` as evidence, `handover deadline passed`, or a guardian proof (`guardian exited`, `guardian pid is free`, or `guardian identity mismatch`) with the `guardianPid`, `expectedIdentity`, `actualIdentity`, and `elapsedProbeMs` as evidence.
  - When the executor's own hard-exit clock ended it: the executor's pid as `senderPid` and `target`, its command supervisor as `container`, `signal` `SIGKILL`, `reason` `shutdown bound expired`, and as evidence the bound as `boundMs` and what armed the clock as `armedBy` (`account stop`, `account gone`, or `signal` with the signal's name, such as `signal SIGTERM`).
  - `container` is the pid of the process that leads the container, which is the command supervisor on every platform. When the supervisor re-raises the executor's own death signal, it reports the executor's status and decides nothing, so an executor that something outside Flywheel killed has no `termination`.
- `logFiles`: the executor's log files of every thread in the project's `.flywheel/log/`, renamed with the `.unexpected-exit.jsonl` suffix so that retention keeps them.
- `output`: the last 8 KiB of the executor's output, which holds a runtime panic's crash report.

## How an executor ended, from its own log

The executor's log in the project's `.flywheel/log/` records how a failure that no code awaits ended (ARCH-RUNTIME-030). A floating abort writes one WARN, `project-executor abort rejection contained`, with its `errorDetail`; repeats of the same abort inside one minute become one count. Every other unhandled rejection or uncaught exception ends the executor with one ERROR, `unhandled rejection` or `uncaught exception`, with the redacted stack in `errorDetail`, after flushing its durable writers for at most one second; a WARN records a flush that failed or ran past that second.

`executor stop signal received` records the first stop signal, with the `signal` and `orderedStop`. With `orderedStop: true`, the executor ran its ordered stop first, and `executor ends by its stop signal` names what ended it as `after`: `stop settled`, `stop failed` with the `error`, or `lifecycle channel detached`. With `orderedStop: false`, it ended at once, and `why` names the reason: `the executor does not serve yet`, `the lifecycle channel is detached`, or `the executor's stop has finished`. The last receipt is INFO because it is routine; the other receipts are WARN.

Every logger record carries its service, and a logger made with `Log.create({ service }).with(context)` carries that context, such as the `projectId` and `generation` of each executor record. The account's records of a project's executor control, such as `executor restarting`, carry the same `projectId`, so one filter on it finds every record of that project's executors.

## Ask User latency

Compare the runtime-client, app-service, and actor timings; a slow client dispatch can hide a fast handler.

## Web client input responsiveness

The shared web client reports `runtime.client.input_responsiveness` through its diagnostic RPC. These notable records land in the account service's files under `~/.flywheel/log/`. Filter by the top-level `sessionId` and the record type: `flywheel events search --project-root "$HOME" --session <id> --type runtime.client.input_responsiveness --latest --json`.

- `clientInstanceId` identifies one mount, including a phone Home Screen mount.
- `dispatchDelayed`, `frameDelayed`, and `unmatchedTap` count anomalies: event delivery or the next animation callback took at least 100 ms, or a stationary actionable pointer release had no matching click within one second. An unmatched tap states an observation, not a cause. `frameWaitMs` is not paint time.
- Each record includes the connection state, visible screen, pane inert and drag state at detection, and at most 16 recent content-free event samples with fixed control and area kinds, input kind, monotonic timestamps, timing, and default prevention.
- Optional `tap` evidence identifies the gesture and original control with mount-local numbers, never DOM attributes, and records the maximum touch count, displacement, duration, touch cancellation, and touch start, move, and end prevention after dispatch. `mouseStages` keeps the first occurrence of each compatibility stage, from mouseover through click, with at most five entries. Release evidence compares the original control with one hit-test at the release point; `controlConnected` records whether the original control remains connected, and `clickOnOtherControl` includes clicks outside the mount. A missing field means that the observer did not capture that stage; older samples have no `tap` object.
- Healthy input writes nothing. The first anomaly reports promptly; repeats in that session's episode produce at most one summary per minute, whose counts exclude the first report. An anomaly in another session ends the earlier episode with its remaining count. At most 16 released taps await click matching at once. Hidden or disconnected mounts do not report. These observations do not diagnose missing taps or change native activation.

## Outbound queue load

`runtime event queue heavy load` warns once at 1,000 and once at 1,500 queued frames per connection, during startup or later. The subscribed, heavy-load, overflow, and unsubscribed records share a `streamId`; the unsubscribed record keeps the lifetime high-water mark and the headroom at that peak. These are connection measurements, not a startup-completion signal or a count of published frames.
