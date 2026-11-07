import { emitToolResultAvailable } from "../../../agent-runtime/emit.js";
import type { BackgroundWorkResult } from "../../../agent-runtime/background-work.js";
import type { SubagentDispatchDeps } from "./dispatch-deps.js";

/** Shows a settled child's result on the parent's live tool-call row. A
 *  partial run is a successful tool call whose work stopped early: the
 *  outcome stays `ok` and the detail carries the cap for the client card. */
export function publishLiveParentResult(onRenderEvent: SubagentDispatchDeps["onRenderEvent"], toolUseId: string, result: BackgroundWorkResult): void {
  emitToolResultAvailable(
    onRenderEvent,
    toolUseId,
    [{ type: "text", text: result.content }],
    result.status === "failed" ? "error" : result.status === "cancelled" || result.status === "stopped" ? result.status : "ok",
    {
      details: {
        ...(result.usage ? { totalTokens: result.usage.totalTokens } : {}),
        ...(result.status === "partial" ? { partial: true } : {}),
      },
    },
  );
}

/** Delivers the parent's durable completion notification: through the
 *  parent's own session when it takes it, else through the background
 *  registry, which holds it for the parent's history. */
export function reconcileParentCompletion(deps: Pick<SubagentDispatchDeps, "subagentSessions" | "sessionId" | "deliverParentNotification" | "backgroundTasks">): void {
  deps.subagentSessions.reconcileParentCompletion(deps.sessionId, async (notification) => {
    if (await deps.deliverParentNotification?.(deps.sessionId, notification)) return true;
    const deliver = deps.backgroundTasks.deliverDurableSubagentNotification;
    if (!deliver) return false;
    deliver(notification);
    return true;
  });
}
