import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { SessionMessaging } from "../session/session-messaging.js";
import type { AgentLoopOptions, AgentLoopTerminal } from "./agent-loop-types.js";
import type { AgentPurpose } from "./types.js";

const log = Log.create({ service: "session-run-observation" });

/** The runs that are the turns of a session other sessions message. Forks,
 *  reviews, titles, and benchmarks share a session id but are not its turns. */
const SESSION_TURN_PURPOSES: ReadonlySet<AgentPurpose["kind"]> = new Set(["interactive-chat", "subagent", "workflow-agent", "headless-task"]);

/** The loop options that the observation reads and wraps. */
type ObservedLoopOptions = Pick<AgentLoopOptions, "sessionId" | "background" | "onTurnAssistantMessage" | "lifecycle">;

/** One run of a session as its reply waits see it. */
export interface ObservedSessionRun<Options extends ObservedLoopOptions = AgentLoopOptions> {
  /** The caller's options, with the assistant callback and lifecycle hooks wrapped. */
  readonly loopOptions: Options;
  /** Reports how the run ended. */
  ended(terminal: AgentLoopTerminal): void;
}

/** Ties one run of a session to the reply waits of its project
 *  (ARCH-SESSIONS-032). Before the first request, the run registers again each wait
 *  that the session holds. While it runs, each park after a request and the
 *  completed end of the run report a yield with the last words it wrote, and
 *  whether the agent asked to wait; the reply waits decide which of their
 *  waits it ends.
 *  An interrupt or another end of the run checks each wait on it, which ends
 *  only when the session can no longer read: an interrupt pauses the wait
 *  until Resume. */
export async function observeSessionRun<Options extends ObservedLoopOptions>(loopOptions: Options, purpose: AgentPurpose, sessions: SessionMessaging | undefined): Promise<ObservedSessionRun<Options>> {
  const sessionId = loopOptions.sessionId;
  if (!sessions || !sessionId || !SESSION_TURN_PURPOSES.has(purpose.kind)) return { loopOptions, ended: () => undefined };
  const waits = await sessions.observeRun({ sessionId, ...(loopOptions.background ? { tasks: loopOptions.background.tasks } : {}) });

  let lastText: string | undefined;
  // The loop's request count at its last park. A park that follows no request
  // ends no turn, such as the park of a hold that a child's resume takes, or
  // a park again after input that folded into history, so it is no yield.
  let requestsAtPark = 0;
  const contained = (work: Promise<void>): void => {
    void work.catch((error: unknown) => { log.warn("reply waits could not observe a session turn", { sessionId, error: errorMessage(error) }); });
  };
  const yielded = (waitRequested: boolean): void => {
    contained(waits.yielded({ ...(lastText ? { lastText } : {}), waitRequested }));
  };
  const { lifecycle } = loopOptions;
  return {
    loopOptions: {
      ...loopOptions,
      onTurnAssistantMessage: (content, entryId) => {
        loopOptions.onTurnAssistantMessage?.(content, entryId);
        const text = content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
        if (text) lastText = text;
      },
      lifecycle: {
        ...lifecycle,
        onTurnParked: async (context) => {
          await lifecycle?.onTurnParked?.(context);
          const ranTurn = context.turnCount > requestsAtPark;
          requestsAtPark = context.turnCount;
          if (context.userResumeRequired) contained(waits.changed());
          else if (ranTurn) yielded(context.waitRequested);
        },
        onTurnResumed: () => {
          waits.resumed();
          lifecycle?.onTurnResumed?.();
          lastText = undefined;
        },
      },
    },
    ended: (terminal) => {
      if (terminal.kind === "completed") yielded(false);
      else contained(waits.changed());
    },
  };
}
