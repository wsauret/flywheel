import type { CapabilityCheck } from "../../infra/capability-text.js";
import type { ConversationMessage } from "./llm/types.js";

type SystemReminder = Extract<ConversationMessage, { kind: "user" }> & { origin: "system" };
export type TurnReminderStatement = "on" | "still" | "off";

/** The text of one statement for the agent check of the request that states it (ARCH-CONTEXT-033). */
export type TurnReminderText = (has: CapabilityCheck) => string;

/** One module's standing mode for this request: its id and three statements, how many person turns pass before
 *  it is stated again, whether it holds now, and the content of statements of an earlier shape. */
export interface TurnReminderState {
  readonly id: string;
  readonly on: TurnReminderText;
  readonly still: TurnReminderText;
  readonly off: TurnReminderText;
  readonly every: number;
  readonly holds: boolean;
  readonly retired?: { readonly [content: string]: TurnReminderStatement };
}

// The marker names the contribution and its statement, so a later release
// recognizes a statement in history however its wording has changed since.
const MARKER = /^<system-reminder mode="([^"\n]+)" state="(on|still|off)">\n/;

const isStatement = (value: string | undefined): value is TurnReminderStatement => value === "on" || value === "still" || value === "off";

const statement = (id: string, state: TurnReminderStatement, body: string): SystemReminder =>
  ({ kind: "user", origin: "system", content: `<system-reminder mode="${id}" state="${state}">\n${body}\n</system-reminder>` });

function statementIn(message: ConversationMessage, state: TurnReminderState): TurnReminderStatement | undefined {
  if (message.kind !== "user" || message.origin !== "system" || typeof message.content !== "string") return undefined;
  const marked = MARKER.exec(message.content);
  if (marked) return marked[1] === state.id && isStatement(marked[2]) ? marked[2] : undefined;
  return state.retired?.[message.content];
}

const isPersonTurn = (message: ConversationMessage | undefined): boolean =>
  message?.kind === "user" && message.origin !== "system";

/**
 * Returns the reminders to append before a request, as hidden system-origin user messages. The conversation is the
 * only record of what the model was told, so a resumed, forked, or compacted conversation decides from what it holds.
 * Only a new person turn gets a reminder: the first one while a mode holds gets `on`, one that comes more than `every` person turns after the latest statement gets `still`, and
 * the first one after the mode stopped holding gets `off`. Each statement renders for `has`, the agent check of this
 * request; the marker, not the wording, identifies it later. Input is never changed.
 */
export function turnReminders(messages: readonly ConversationMessage[], states: readonly TurnReminderState[], has: CapabilityCheck): readonly SystemReminder[] {
  if (!isPersonTurn(messages.at(-1))) return [];
  return states.flatMap((state) => {
    let latest: TurnReminderStatement | undefined;
    let turns = 0;
    for (const message of messages.toReversed()) {
      latest = statementIn(message, state);
      if (latest !== undefined) break;
      if (isPersonTurn(message)) turns++;
    }
    const stated = latest === "on" || latest === "still";
    if (state.holds) return !stated ? [statement(state.id, "on", state.on(has))] : turns > state.every ? [statement(state.id, "still", state.still(has))] : [];
    return stated ? [statement(state.id, "off", state.off(has))] : [];
  });
}
