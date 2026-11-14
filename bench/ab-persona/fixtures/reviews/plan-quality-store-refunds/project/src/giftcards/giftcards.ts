export interface GiftCard {
  readonly number: string;
  readonly balanceCents: number;
}

export interface GiftCardStore {
  get(number: string): Promise<GiftCard | undefined>;
  put(card: GiftCard): Promise<void>;
}

export class GiftCardError extends Error {}

/** Issue a new gift card holding `cents`. */
export async function issueGiftCard(store: GiftCardStore, newNumber: () => string, cents: number): Promise<GiftCard> {
  const card = { number: newNumber(), balanceCents: cents };
  await store.put(card);
  return card;
}

/** Add `cents` to an existing gift card. Throws GiftCardError for an unknown card. */
export async function loadGiftCard(store: GiftCardStore, number: string, cents: number): Promise<GiftCard> {
  const card = await store.get(number);
  if (card === undefined) throw new GiftCardError(`Unknown gift card ${number}`);
  const next = { ...card, balanceCents: card.balanceCents + cents };
  await store.put(next);
  return next;
}
