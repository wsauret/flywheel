import type { Hold, HoldStore } from "../src/holds";
import type { Loan, LoanStore } from "../src/loans";

export function memoryLoans(initial: Loan[]): LoanStore & { readonly loans: Loan[] } {
  const loans = [...initial];
  return {
    loans,
    get: async (id) => loans.find((loan) => loan.id === id),
    forPatron: async (patronId) => loans.filter((loan) => loan.patronId === patronId),
    save: async (loan) => {
      const index = loans.findIndex((candidate) => candidate.id === loan.id);
      if (index === -1) loans.push(loan);
      else loans[index] = loan;
    },
  };
}

export function memoryHolds(holds: Hold[]): HoldStore {
  return { forItem: async (itemId) => holds.filter((hold) => hold.itemId === itemId) };
}
