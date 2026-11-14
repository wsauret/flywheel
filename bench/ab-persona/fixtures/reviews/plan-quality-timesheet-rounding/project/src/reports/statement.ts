import type { Client } from "../clients";
import type { TimeEntry } from "../entries";
import { billableMinutes } from "../billing/time";

export interface Statement {
  readonly clientName: string;
  readonly month: string;
  /** Billed hours of the month, two decimals. */
  readonly billedHours: string;
  readonly entryCount: number;
}

/** The monthly statement: the client's billed hours in one month ("2027-02"). */
export function monthlyStatement(client: Client, entries: readonly TimeEntry[], month: string): Statement {
  const inMonth = entries.filter((entry) => entry.clientId === client.id && entry.date.startsWith(`${month}-`));
  const minutes = inMonth.reduce((sum, entry) => sum + billableMinutes(entry), 0);
  return { clientName: client.name, month, billedHours: (minutes / 60).toFixed(2), entryCount: inMonth.length };
}
