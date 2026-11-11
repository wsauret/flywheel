import type { Card } from "../domain/types.ts";

const DAY_MS = 86_400_000;

export function renderCard(card: Card, now: number): string {
  if (card.blocker === null) return `  - ${card.title}`;
  const days = Math.floor((now - card.blocker.since) / DAY_MS);
  return `  - ${card.title}  [blocked ${days}d: ${card.blocker.reason}]`;
}
