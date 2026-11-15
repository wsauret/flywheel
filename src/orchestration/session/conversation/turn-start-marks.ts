import { messageSenderOf, type AnyBlock } from "../../../infra/output-blocks.js";
import { withTurnStart } from "../../../infra/output/turn-start.js";
import { isBriefEntry } from "./brief-entry.js";
import type { MessageEntry } from "./conversation-entry-types.js";

/** The history projection's marks of turns that the runtime started (`turnStart`). A hidden system message or a message
 *  from another session after a finished turn, one whose last assistant entry made no call, starts such a turn, and the
 *  first row of output after it is that turn's start, as the live output's gate marks it. Any other user message, a
 *  person's included, opens a turn of its own. */
export function createTurnStartMarks() {
  let turnEnded = false;
  let pending = false;
  /** Indices of the rows placed first in a turn that the runtime started. */
  const starts = new Set<number>();
  /** The marked copy of each row, so every snapshot hands out the same object for it. */
  const marked = new WeakMap<AnyBlock, AnyBlock>();

  const mark = (block: AnyBlock): AnyBlock => {
    let copy = marked.get(block);
    if (copy === undefined) {
      copy = withTurnStart(block);
      marked.set(block, copy);
    }
    return copy;
  };

  return {
    /** Reads one message entry before its rows are placed. */
    observe(id: string, message: MessageEntry["message"]): void {
      const runtimeInput = message.kind === "user" && (message.origin === "system" ? !message.invocation && !isBriefEntry(id) : messageSenderOf(message.producer) !== undefined);
      if (runtimeInput) {
        if (turnEnded) pending = true;
        turnEnded = false;
      } else if (message.kind === "user") {
        turnEnded = false;
        pending = false;
      } else if (message.kind === "assistant") {
        turnEnded = typeof message.content === "string" || !message.content.some((part) => part.type === "tool_use");
      }
    },
    /** Notes the index of a row as it is placed, and answers that index. */
    placed(index: number): number {
      if (pending) starts.add(index);
      pending = false;
      return index;
    },
    /** The rows that show, each turn start marked. A mark on a hidden row, or on a row that carries none, such as the
     *  Resumed notice or another session's message, passes to the turn's next row of output; a person's message ends it. */
    shown(blocks: readonly AnyBlock[], hidden: ReadonlySet<number>): AnyBlock[] {
      if (starts.size === 0) return blocks.filter((_, index) => !hidden.has(index));
      const shown: AnyBlock[] = [];
      let opens = false;
      for (const [index, block] of blocks.entries()) {
        opens ||= starts.has(index);
        if (hidden.has(index)) continue;
        const row = opens ? mark(block) : block;
        shown.push(row);
        if (row !== block || (block.kind === "userMessage" && block.from === undefined)) opens = false;
      }
      return shown;
    },
  };
}
