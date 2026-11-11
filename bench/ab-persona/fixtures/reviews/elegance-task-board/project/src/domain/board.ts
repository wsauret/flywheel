import { exceedsWipLimit } from "../ui/board-view.ts";
import type { Board, Card, Column } from "./types.ts";

export interface ColumnSpec {
  name: string;
  wipLimit: number | null;
}

export function createBoard(id: string, name: string, columnSpecs: readonly ColumnSpec[]): Board {
  if (columnSpecs.length === 0) throw new Error("A board needs at least one column");
  const columns = columnSpecs.map((spec, index) => ({
    id: `col_${index + 1}`,
    name: spec.name,
    wipLimit: checkedWipLimit(spec.wipLimit),
    cardIds: [],
  }));
  return { id, name, columns, cards: [] };
}

export function columnById(board: Board, columnId: string): Column {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  if (column === undefined) throw new Error(`Board ${board.id} has no column ${columnId}`);
  return column;
}

export function cardById(board: Board, cardId: string): Card {
  const card = board.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) throw new Error(`Board ${board.id} has no card ${cardId}`);
  return card;
}

/** New cards start at the bottom of the first column. */
export function addCard(board: Board, title: string, now: number): Card {
  const [firstColumn] = board.columns;
  if (firstColumn === undefined) throw new Error(`Board ${board.id} has no columns`);
  assertRoomFor(firstColumn);
  const card: Card = { id: crypto.randomUUID(), title, columnId: firstColumn.id, createdAt: now, blocker: null };
  board.cards.push(card);
  firstColumn.cardIds.push(card.id);
  return card;
}

/** Put a card at `position` in a column, counted among the column's other
 *  cards. A move inside one column only reorders it, so it never trips the
 *  WIP limit. */
export function moveCard(board: Board, cardId: string, toColumnId: string, position: number): void {
  const card = cardById(board, cardId);
  const from = columnById(board, card.columnId);
  const to = columnById(board, toColumnId);
  if (from !== to) assertRoomFor(to);
  const others = to.cardIds.filter((id) => id !== card.id);
  if (!Number.isInteger(position) || position < 0 || position > others.length) {
    throw new RangeError(`Position ${position} is outside ${to.name}, which has room for 0 to ${others.length}`);
  }
  from.cardIds = from.cardIds.filter((id) => id !== card.id);
  others.splice(position, 0, card.id);
  to.cardIds = others;
  card.columnId = to.id;
}

/** Lowering a limit below the current card count is allowed: the board
 *  shows the column as over its limit until cards move out. */
export function setWipLimit(board: Board, columnId: string, limit: number | null): void {
  columnById(board, columnId).wipLimit = checkedWipLimit(limit);
}

/** Mark a card blocked. Blocking an already blocked card replaces the reason
 *  but keeps the original start, so the blocked age stays honest. */
export function blockCard(board: Board, cardId: string, reason: string, now: number): void {
  const trimmed = reason.trim();
  if (trimmed === "") throw new Error("Say why the card is blocked");
  const card = cardById(board, cardId);
  card.blocker = { reason: trimmed, since: card.blocker?.since ?? now };
}

export function unblockCard(board: Board, cardId: string): void {
  cardById(board, cardId).blocker = null;
}

export function cardsIn(board: Board, columnId: string): Card[] {
  const byId = new Map(board.cards.map((card) => [card.id, card]));
  return columnById(board, columnId).cardIds.map((id) => {
    const card = byId.get(id);
    if (card === undefined) throw new Error(`Column ${columnId} lists missing card ${id}`);
    return card;
  });
}

function assertRoomFor(column: Column): void {
  if (exceedsWipLimit(column, column.cardIds.length + 1)) {
    throw new Error(`${column.name} is at its WIP limit of ${column.wipLimit}`);
  }
}

function checkedWipLimit(limit: number | null): number | null {
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError(`A WIP limit must be a whole number of at least 1, got ${limit}`);
  }
  return limit;
}
