import type { Currency, RateProvider } from "./types.ts";

/** In-memory rate table refreshed by a market-data poller elsewhere in the
 *  service. Rates drift over the life of the process. */
export class RateTable implements RateProvider {
  private readonly rates = new Map<Currency, number>([["USD", 1]]);

  update(currency: Currency, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Rejected non-positive rate ${rate} for ${currency}`);
    }
    this.rates.set(currency, rate);
  }

  current(currency: Currency): number {
    const rate = this.rates.get(currency);
    if (rate === undefined) {
      throw new Error(`No rate loaded for ${currency}`);
    }
    return rate;
  }
}

/** JPY has no minor unit; every other currency we support uses cents. */
export function minorUnitsPerMajor(currency: Currency): number {
  return currency === "JPY" ? 1 : 100;
}
