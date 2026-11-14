import type { IsoDate } from "./dates";

export interface Loan {
  readonly id: string;
  readonly itemId: string;
  readonly patronId: string;
  readonly dueOn: IsoDate;
  /** How many times the loan has been renewed, at the desk or online. */
  readonly renewals: number;
  readonly returnedOn?: IsoDate;
}

export interface LoanStore {
  get(id: string): Promise<Loan | undefined>;
  forPatron(patronId: string): Promise<readonly Loan[]>;
  save(loan: Loan): Promise<void>;
}
