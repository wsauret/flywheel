import { cardsIn } from "../domain/board.ts";
import type { Board, Card, Column } from "../domain/types.ts";
import { renderCard } from "./card-view.ts";

/** Whether `count` cards would be more than the column allows. */
export function exceedsWipLimit(column: Column, count: number): boolean {
  return column.wipLimit !== null && count > column.wipLimit;
}

export function renderBoard(board: Board, now: number): string {
  const sections = board.columns.map((column) => {
    const cards = cardsIn(board, column.id);
    return [columnHeader(column, cards), ...cards.map((card) => renderCard(card, now))].join("\n");
  });
  return [`# ${board.name}`, ...sections].join("\n\n");
}

/** For example "In progress (5/4) ! over limit, 2 blocked". */
function columnHeader(column: Column, cards: readonly Card[]): string {
  const capacity = column.wipLimit === null ? `${cards.length}` : `${cards.length}/${column.wipLimit}`;
  const blocked = cards.filter((card) => card.blocker !== null).length;
  const warnings: string[] = [];
  if (exceedsWipLimit(column, cards.length)) warnings.push("over limit");
  if (blocked > 0) warnings.push(`${blocked} blocked`);
  const heading = `${column.name} (${capacity})`;
  return warnings.length === 0 ? heading : `${heading} ! ${warnings.join(", ")}`;
}
