import type { LoanStore } from "../loans";

export interface Session {
  readonly patronId: string;
}

export interface WebResponse {
  readonly status: number;
  readonly body: unknown;
}

/** GET /account/loans: the signed-in patron's loans that are not returned, soonest due first. */
export async function getLoans(loans: LoanStore, session: Session): Promise<WebResponse> {
  const open = (await loans.forPatron(session.patronId)).filter((loan) => loan.returnedOn === undefined);
  return { status: 200, body: [...open].sort((a, b) => a.dueOn.localeCompare(b.dueOn)) };
}
