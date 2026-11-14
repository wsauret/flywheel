import type { IsoDate } from "./dates";

export interface Hold {
  readonly itemId: string;
  readonly patronId: string;
  readonly placedOn: IsoDate;
  /** The last day the hold waits; after it the hold has lapsed and is kept only for statistics. */
  readonly expiresOn: IsoDate;
}

export interface HoldStore {
  forItem(itemId: string): Promise<readonly Hold[]>;
}

function activeHolds(holds: readonly Hold[], today: IsoDate): readonly Hold[] {
  return holds.filter((hold) => hold.expiresOn >= today);
}

/** True when a hold on the item is still waiting today. */
export async function isOnHold(store: HoldStore, itemId: string, today: IsoDate): Promise<boolean> {
  return activeHolds(await store.forItem(itemId), today).length > 0;
}
