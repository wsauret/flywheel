export interface Account {
  id: string;
  currency: string;
  /** Minor units (cents). */
  balance: number;
  /** How far below zero the balance may go, in minor units. */
  overdraftLimit: number;
}

export class InsufficientFunds extends Error {}
export class UnknownAccount extends Error {}

/** Account ids are case-insensitive and ignore surrounding spaces. */
export function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

export class AccountBook {
  private readonly accounts = new Map<string, Account>();

  open(id: string, currency: string, overdraftLimit = 0): Account {
    const key = normalizeId(id);
    const account: Account = { id: key, currency, balance: 0, overdraftLimit };
    this.accounts.set(key, account);
    return account;
  }

  get(id: string): Account {
    const account = this.accounts.get(normalizeId(id));
    if (account === undefined) throw new UnknownAccount(id);
    return account;
  }

  all(): Account[] {
    return [...this.accounts.values()];
  }

  restore(accounts: readonly Account[]): void {
    this.accounts.clear();
    for (const account of accounts) this.accounts.set(normalizeId(account.id), { ...account });
  }

  debit(account: Account, amount: number): void {
    if (account.balance - amount < -account.overdraftLimit) {
      throw new InsufficientFunds(`${account.id} cannot cover ${amount}`);
    }
    account.balance -= amount;
  }

  credit(account: Account, amount: number): void {
    account.balance += amount;
  }
}
