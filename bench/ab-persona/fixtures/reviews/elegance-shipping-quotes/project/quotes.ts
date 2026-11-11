import type { Carrier } from "./carriers.ts";
import type { Parcel } from "./types.ts";

export interface Quote {
  carrierName: string;
  priceCents: number;
}

export interface QuoteSet {
  /** Successful quotes, cheapest first. */
  quotes: Quote[];
  /** Names of carriers whose rate request failed. */
  unavailable: string[];
}

type CarrierOutcome = { kind: "quoted"; quote: Quote } | { kind: "unavailable"; carrierName: string };

export class QuoteService {
  lastQuotes: QuoteSet | undefined;

  constructor(private readonly carriers: readonly Carrier[]) {}

  /** Ask every carrier at once. One failing carrier does not hide the others. */
  async quoteAll(parcel: Parcel): Promise<QuoteSet> {
    const outcomes = await Promise.all(
      this.carriers.map((carrier) =>
        carrier.quote(parcel).then(
          (priceCents): CarrierOutcome => ({
            kind: "quoted",
            quote: { carrierName: carrier.name, priceCents },
          }),
          (): CarrierOutcome => ({ kind: "unavailable", carrierName: carrier.name }),
        ),
      ),
    );
    const quotes: Quote[] = [];
    const unavailable: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === "quoted") quotes.push(outcome.quote);
      else unavailable.push(outcome.carrierName);
    }
    quotes.sort((a, b) => a.priceCents - b.priceCents || a.carrierName.localeCompare(b.carrierName));
    const set = { quotes, unavailable };
    this.lastQuotes = set;
    return set;
  }
}
