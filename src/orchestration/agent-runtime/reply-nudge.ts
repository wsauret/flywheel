/**
 * Visible-reply guard for human-facing loops.
 *
 * It prevents a human turn from parking without a visible reply.
 */

export const SILENT_REPLY_NUDGE =
  "[silent-reply notice] The user has not received a reply. Answer their message before waiting; a brief status is enough if work is still running.";

const SILENT_PROGRESS_REMINDER =
  "The user hasn't heard from you in a while. Do not mention or acknowledge this reminder or any other runtime steering in your reply. Do not apologize for it. Continue working, and only send the user task-relevant progress, results, or a concrete blocker.";

const SILENT_TURNS_BETWEEN_REMINDERS = 5;
const MAX_PROGRESS_REMINDERS_PER_STRETCH = 3;

export interface ReplyNudge {
  /** Human input or an actionable background result entered the conversation:
   * a visible reply is owed. */
  visibleReplyRequired(): void;
  /** A committed turn delivered visible text (or an equivalent user-facing
   *  surface such as a successful ask_user): the debt is settled. */
  visibleTextDelivered(): void;
  /** Starts one assistant turn with no delivered text. */
  assistantTurnStarted(): void;
  /** Records committed assistant content and updates the progress cadence. */
  assistantContentCommitted(visibleText: boolean): void;
  /** True when the current assistant turn committed visible text. */
  turnHasVisibleText(): boolean;
  /** Adds a due progress reminder to one request's non-durable context. */
  consumeRequestContext(requestContext: string | undefined): string | undefined;
  /** Preview the next request without advancing the reminder cadence. */
  previewRequestContext(requestContext: string | undefined): string | undefined;
  /** The loop is about to park. True exactly once per owed reply: the caller
   *  must inject SILENT_REPLY_NUDGE and re-drive the loop instead of parking. */
  consumeNudge(): boolean;
}

export function createReplyNudge(enabled: boolean): ReplyNudge {
  let owed = false;
  let turnVisibleText = false;
  let nudged = false;
  let silentTurns = 0;
  let progressReminders = 0;
  const resetProgressStretch = (): void => {
    silentTurns = 0;
    progressReminders = 0;
  };
  return {
    visibleReplyRequired(): void {
      if (!enabled) return;
      owed = true;
      nudged = false;
      resetProgressStretch();
    },
    visibleTextDelivered(): void {
      owed = false;
      nudged = false;
      resetProgressStretch();
    },
    assistantTurnStarted(): void {
      turnVisibleText = false;
    },
    assistantContentCommitted(visibleText: boolean): void {
      turnVisibleText = visibleText;
      if (visibleText) {
        this.visibleTextDelivered();
        return;
      }
      if (enabled) silentTurns += 1;
    },
    turnHasVisibleText(): boolean {
      return turnVisibleText;
    },
    previewRequestContext(requestContext: string | undefined): string | undefined {
      if (
        silentTurns < SILENT_TURNS_BETWEEN_REMINDERS
        || progressReminders >= MAX_PROGRESS_REMINDERS_PER_STRETCH
      ) return requestContext;
      return requestContext === undefined
        ? SILENT_PROGRESS_REMINDER
        : `${requestContext}\n\n${SILENT_PROGRESS_REMINDER}`;
    },
    consumeRequestContext(requestContext: string | undefined): string | undefined {
      const next = this.previewRequestContext(requestContext);
      if (next !== requestContext) {
        silentTurns = 0;
        progressReminders += 1;
      }
      return next;
    },
    consumeNudge(): boolean {
      if (!owed || nudged) return false;
      nudged = true;
      return true;
    },
  };
}
