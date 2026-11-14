export interface CreditStore {
  balance(customerId: string): Promise<number>;
  setBalance(customerId: string, cents: number): Promise<void>;
}

/** Add `cents` of store credit to a customer account. The loyalty desk uses it today for goodwill credit. */
export async function addStoreCredit(store: CreditStore, customerId: string, cents: number): Promise<number> {
  const next = (await store.balance(customerId)) + cents;
  await store.setBalance(customerId, next);
  return next;
}
