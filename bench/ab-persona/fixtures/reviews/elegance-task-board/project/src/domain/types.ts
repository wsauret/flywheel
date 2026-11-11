export interface Column {
  id: string;
  name: string;
  /** Most cards the column may hold, or null when it has no limit. */
  wipLimit: number | null;
  /** Ids of the column's cards in display order, top first. */
  cardIds: string[];
}

export interface Blocker {
  reason: string;
  since: number;
}

export interface Card {
  id: string;
  title: string;
  columnId: string;
  createdAt: number;
  blocker: Blocker | null;
}

export interface Board {
  id: string;
  name: string;
  columns: Column[];
  cards: Card[];
}
