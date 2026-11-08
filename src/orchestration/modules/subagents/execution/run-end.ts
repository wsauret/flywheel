import { Log } from "../../../../infra/log.js";
import type { BackgroundKillSource } from "../../../agent-runtime/background-work.js";
import { failureTerminal, type AgentRunTerminal } from "../../../agent-runtime/types.js";
import type { TurnInterruption } from "../../../session/conversation/turn-end-record.js";
import type { SubagentInput } from "./control-actions.js";

const log = Log.create({ service: "subagent-run-end" });

/** How one run of a subagent ends. The run is `open` until the first event
 *  that decides its end: its handoff, an interrupt, a Stop, or the return of
 *  its loop. A loop that returns aborted with no cut is paused by the runtime;
 *  a loop that returns anything else is `returned`, and the run settles from
 *  what the loop returned. A refused write, a failure after a handoff, or a
 *  failed settlement overrides every end with `failed`. A Stop by a person or a deletion is `user`, a Stop
 *  by the parent agent is `agent`. */
export type RunEnd =
  | { readonly kind: "open" }
  | { readonly kind: "handed_off"; readonly payload: SubagentInput }
  | { readonly kind: "paused"; readonly by: TurnInterruption }
  | { readonly kind: "stopped"; readonly by: "user" | "agent" }
  | { readonly kind: "returned" }
  | { readonly kind: "failed" };

type DecidedRunEnd = Exclude<RunEnd, { readonly kind: "open" } | { readonly kind: "failed" }>;

/** The one owner of a run's end and of when an event cancels the run's work.
 *  Every event of the run goes through it:
 *  - `handOff`, `interrupt`, `stop`, and `loopReturned` decide the end when it
 *    is open, and the first wins. A refused cut writes one INFO record.
 *  - `interrupt` aborts only the run it paused: a decided run has nothing
 *    left to keep for a resume. Returns whether it paused the run.
 *  - `stop` and the registry's `kill` abort what the run still does unless
 *    the run handed off, whose settlement only records its result. So a Stop
 *    still ends a failed run's summary, and its failure stays the result.
 *  - `kill` by the runtime, as its parent's host closes, decides nothing.
 *  - `loopReturned` fails a loop whose write was refused, which
 *    `runner/agent-turn.ts` returns rather than throws: a handoff that was
 *    not saved did not complete, and a turn that was not saved cannot resume.
 *    It also fails a handoff that a later failure other than an abort
 *    followed, such as a local save fault that `runner/agent-turn.ts`
 *    returns as `api_error`: the handoff's turn did not end cleanly.
 *  - `fail` fails a run whose loop or settlement threw.
 *  `abort` is called synchronously in the same step as the decision, so the
 *  handoff tool, which checks its signal and captures in one step, either
 *  sees the abort and captures nothing or captures before any cut. */
export function createRunEnd(input: { readonly childSessionId: string; readonly childRunId: string; readonly abort: () => void }) {
  let current: RunEnd = { kind: "open" };
  const decide = (next: DecidedRunEnd): boolean => {
    if (current.kind !== "open") return false;
    current = next;
    return true;
  };
  const refused = (cut: "paused" | "stopped", by: string): void => {
    log.info("subagent cut refused", { childSessionId: input.childSessionId, childRunId: input.childRunId, cut, by, runEnd: current.kind });
  };
  const cancel = (): void => {
    if (current.kind !== "handed_off") input.abort();
  };
  const stop = (by: "user" | "agent"): void => {
    if (!decide({ kind: "stopped", by })) refused("stopped", by);
    cancel();
  };
  return {
    get current(): RunEnd { return current; },
    handOff(payload: SubagentInput): void { decide({ kind: "handed_off", payload }); },
    interrupt(by: TurnInterruption): boolean {
      if (!decide({ kind: "paused", by })) {
        refused("paused", by);
        return false;
      }
      input.abort();
      return true;
    },
    stop,
    kill(source: BackgroundKillSource): void {
      if (source === "runtime") cancel();
      else stop(source);
    },
    loopReturned(terminal: AgentRunTerminal): void {
      const failure = failureTerminal(terminal);
      if (failure?.kind === "local_persistence_error" || (current.kind === "handed_off" && failure && failure.kind !== "aborted")) current = { kind: "failed" };
      else decide(terminal.kind === "aborted" ? { kind: "paused", by: "runtime" } : { kind: "returned" });
    },
    fail(): void { current = { kind: "failed" }; },
  };
}
