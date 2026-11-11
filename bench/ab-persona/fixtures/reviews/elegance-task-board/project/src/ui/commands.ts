import { addCard, blockCard, moveCard, setWipLimit, unblockCard } from "../domain/board.ts";
import type { Board } from "../domain/types.ts";

export type Command =
  | { kind: "add"; title: string }
  | { kind: "move"; cardId: string; columnId: string; position: number }
  | { kind: "block"; cardId: string; reason: string }
  | { kind: "unblock"; cardId: string }
  | { kind: "limit"; columnId: string; limit: number | null };

const USAGE: Record<Command["kind"], string> = {
  add: "add <title>",
  move: "move <card> <column> <position>",
  block: "block <card> <reason>",
  unblock: "unblock <card>",
  limit: "limit <column> <number|none>",
};

/** Parse one line typed into the terminal client, for example
 *  "move 3f2a col_2 0". This checks syntax only; the board rules decide
 *  whether the command is allowed. */
export function parseCommand(line: string): Command {
  const [verb = "", ...args] = line.trim().split(/\s+/);
  switch (verb) {
    case "add": {
      const title = args.join(" ");
      if (title === "") throw usageError("add");
      return { kind: "add", title };
    }
    case "move": {
      const [cardId, columnId, position] = args;
      if (cardId === undefined || columnId === undefined || position === undefined) throw usageError("move");
      return { kind: "move", cardId, columnId, position: parseInteger(position) };
    }
    case "block": {
      const [cardId, ...reasonWords] = args;
      if (cardId === undefined || reasonWords.length === 0) throw usageError("block");
      return { kind: "block", cardId, reason: reasonWords.join(" ") };
    }
    case "unblock": {
      const [cardId] = args;
      if (cardId === undefined) throw usageError("unblock");
      return { kind: "unblock", cardId };
    }
    case "limit": {
      const [columnId, limit] = args;
      if (columnId === undefined || limit === undefined) throw usageError("limit");
      return { kind: "limit", columnId, limit: limit === "none" ? null : parseInteger(limit) };
    }
    default:
      throw new Error(`Unknown command "${verb}". Commands: ${Object.values(USAGE).join("; ")}`);
  }
}

export function applyCommand(board: Board, command: Command, now: number): void {
  switch (command.kind) {
    case "add":
      addCard(board, command.title, now);
      return;
    case "move":
      moveCard(board, command.cardId, command.columnId, command.position);
      return;
    case "block":
      blockCard(board, command.cardId, command.reason, now);
      return;
    case "unblock":
      unblockCard(board, command.cardId);
      return;
    case "limit":
      setWipLimit(board, command.columnId, command.limit);
      return;
  }
}

function parseInteger(text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value)) throw new Error(`"${text}" is not a whole number`);
  return value;
}

function usageError(kind: Command["kind"]): Error {
  return new Error(`Usage: ${USAGE[kind]}`);
}
