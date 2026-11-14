import type { Client } from "../clients";
import type { TimeEntry } from "../entries";
import { billableMinutes } from "./time";

export interface InvoiceLine {
  readonly date: string;
  readonly description: string;
  /** Billed time as shown on the invoice, in hours with two decimals. */
  readonly hours: string;
  readonly amountCents: number;
}

export interface Invoice {
  readonly clientId: string;
  readonly lines: readonly InvoiceLine[];
  readonly totalCents: number;
  readonly notes: readonly string[];
}

/** One line per entry, in the order given. */
export function buildInvoice(client: Client, entries: readonly TimeEntry[]): Invoice {
  const lines = entries.map((entry) => {
    const minutes = billableMinutes(entry);
    return {
      date: entry.date,
      description: entry.description,
      hours: (minutes / 60).toFixed(2),
      amountCents: Math.round((minutes * client.hourlyRateCents) / 60),
    };
  });
  return {
    clientId: client.id,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    notes: [],
  };
}
