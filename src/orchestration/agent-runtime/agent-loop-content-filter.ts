// Anthropic surfaces `refusal`/`sensitive` stops as `content_filter`. These are
// often spurious classifier misfires (a few-token refusal with no visible text),
// so the loop retries with a nudge instead of silently parking. Consecutive
// retries are capped; on give-up the user gets a visible notice rather than a
// silent turn end.
import { Log } from "../../infra/log.js";
import type { LlmStopReason } from "./llm/types.js";

const log = Log.create({ service: "agent-loop" });

/** The consecutive content-filter stops without a tool call that the loop
 *  retries before it ends the turn as the provider's refusal.
 *
 *  @public
 *  `bench/terminal_bench/trial-store-analysis.ts` reads it to tell a refusal
 *  from a trial that ended while a retry was owed. Knip does not trace bench
 *  into the production project, so this export is not dead. */
export const MAX_CONTENT_FILTER_RETRIES = 2;

const CONTENT_FILTER_NUDGE =
  "Your previous response was stopped by the provider's content filter before it completed. This is usually a spurious classifier misfire. Continue the task from where you left off.";

const CONTENT_FILTER_BLOCKED_NOTICE =
  "The provider's content filter blocked the response repeatedly. Rephrase the request or try a different model.";

export interface ContentFilterRecoveryDeps {
  providerSessionKey: string;
  pushUser: (content: string) => void | Promise<void>;
  onSystemMessage?: (message: string, level?: "info" | "error") => void;
}

export interface ContentFilterRecovery {
  /** Call once per completed turn, after assistant content is pushed. "retry"
   *  means a nudge was pushed and the loop should continue; "end" means
   *  proceed with normal turn-end handling; "refused" means the retries ran
   *  out, so the turn ends as the provider's refusal of the content. */
  observe(turn: { stopReason: LlmStopReason; hadToolCalls: boolean; turnCount: number }): Promise<"retry" | "end" | "refused">;
}

export function createContentFilterRecovery({ providerSessionKey, pushUser, onSystemMessage }: ContentFilterRecoveryDeps): ContentFilterRecovery {
  let retries = 0;
  return {
    async observe({ stopReason, hadToolCalls, turnCount }) {
      if (stopReason !== "content_filter") {
        retries = 0;
        return "end";
      }
      if (hadToolCalls) return "end";
      if (retries < MAX_CONTENT_FILTER_RETRIES) {
        retries++;
        log.warn("content_filter stop with no tool calls; auto-continuing", { retries, turnCount, providerSessionKey });
        await pushUser(CONTENT_FILTER_NUDGE);
        return "retry";
      }
      log.warn("content_filter retries exhausted; surfacing to user", { retries, turnCount, providerSessionKey });
      onSystemMessage?.(CONTENT_FILTER_BLOCKED_NOTICE, "error");
      return "refused";
    },
  };
}
