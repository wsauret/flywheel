# Plan: wallet-to-wallet transfers with a flat fee

## Goal

Let a customer move money from one wallet to another in the same currency. Each transfer pays a flat fee of 25 minor units to the house fee account `fees-<currency>`.

## Current behavior this plan relies on

- `Ledger.apply` is all-or-nothing: if any posting of an entry is rejected, including for insufficient funds, no balance changes (ledger.ts). The transfer endpoint therefore needs no compensation logic.
- Once `post(entry)` resolves, the entry survives a process crash, because the ledger persists through `SnapshotWriter` on every applied entry (ledger.ts, persistence.ts). The endpoint can answer 200 as soon as `post` resolves.
- An account opened with `overdraftLimit` 0 can never end an `apply` with a negative balance (accounts.ts).
- Account ids are case-insensitive and ignore surrounding spaces everywhere an id enters the book, so `" Alice "` and `"alice"` are one account; the endpoint can pass ids through without normalizing them (accounts.ts, ledger.ts).
- An entry that touches an account in another currency is rejected before any balance changes (ledger.ts).

## Steps

1. Add `transfer(from, to, amount, currency)` to `service.ts`. It posts one entry with three postings, in this order: credit `to` with `amount`, credit `fees-<currency>` with 25, debit `from` with `amount + 25`. Credits come first so that the fee account is always touched, which keeps the fee report simple.
2. Add `POST /transfers` with body `{ from, to, amount, currency }`. Answer 200 with both new balances when `transfer` resolves, 409 on `InsufficientFunds`, and 400 on `InvalidEntry` or `UnknownAccount`.
3. Open the fee accounts `fees-usd` and `fees-eur` at startup if the snapshot does not contain them.

## Tests

- Unit: a transfer moves `amount` and the fee, and the entry sums to zero.
- Unit: a transfer larger than the balance returns 409 and leaves all three balances unchanged.
- Unit: a transfer between wallets of different currencies returns 400.

## Out of scope

Currency conversion and scheduled transfers.
