/**
 * Bounded reminder for a turn that ends over pending managed work without a
 * wait call. The model gets one reminder. A model that ignores it gets no
 * more requests: the runtime waits for it with the default wait, as a wait
 * call without an estimate does. The person sees nothing: the wait is the
 * agent's bookkeeping, not news for the person.
 * The model's next wait call or the person's next message earns one reminder
 * again.
 */
import { Log } from "../../infra/log.js";
import { DEFAULT_WAIT_SECONDS } from "./tools/process.js";

const log = Log.create({ service: "agent-loop" });

const PENDING_WORK_NUDGE = "Managed work is still pending. To wait, call process(action='wait') with soft_timeout seconds from a fresh remaining-work estimate. Estimate all managed work. Each explicit wait ends on completion or expiry without stopping work. Do not send status chatter.";

interface PendingWorkNudgeDeps {
  readonly providerSessionKey: string;
  readonly pushUser: (content: string) => Promise<void>;
}

export interface PendingWorkNudge {
  /** The model called a wait, or a person wrote. */
  reset(): void;
  /** A turn ended over pending work without a wait call. Answers undefined
   *  after it pushes the reminder, which the loop answers with a request.
   *  Otherwise it answers the seconds the runtime waits on the model's behalf. */
  turnEndedWithoutWait(turnCount: number): Promise<number | undefined>;
}

export function createPendingWorkNudge({ providerSessionKey, pushUser }: PendingWorkNudgeDeps): PendingWorkNudge {
  let stage: "unsent" | "sent" | "ignored" = "unsent";
  return {
    reset() {
      stage = "unsent";
    },
    async turnEndedWithoutWait(turnCount) {
      if (stage === "unsent") {
        stage = "sent";
        await pushUser(PENDING_WORK_NUDGE);
        return undefined;
      }
      if (stage === "sent") {
        stage = "ignored";
        log.info("pending-work nudge ignored; runtime waits on the agent's behalf", { turnCount, waitSeconds: DEFAULT_WAIT_SECONDS, providerSessionKey });
      }
      return DEFAULT_WAIT_SECONDS;
    },
  };
}
