import type { Query } from "./types.ts";

export interface PageState {
  query: Query;
  offset: number;
}

/** Cursor tokens are opaque handles into server-side page state, so clients
 *  cannot tamper with offsets or another viewer's query. */
const live = new Map<string, PageState>();

let counter = 0;

export function issueCursor(state: PageState): string {
  const token = `cur_${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  live.set(token, state);
  return token;
}

export function resolveCursor(token: string): PageState {
  const state = live.get(token);
  if (!state) {
    throw new Error(`Unknown or expired cursor: ${token}`);
  }
  return state;
}

/** Drop server-side state for cursors a client will no longer use. */
export function releaseCursor(token: string): void {
  live.delete(token);
}
