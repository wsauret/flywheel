import type { QuoteSet } from "./quotes.ts";

/** Lines for the shipping step of checkout, e.g. "Parcel Express  $7.40  (cheapest)". */
export function renderShippingOptions(set: QuoteSet): string[] {
  const lines = set.quotes.map((quote, index) => {
    const marker = index === 0 ? "  (cheapest)" : "";
    return `${quote.carrierName}  ${toDollars(quote.priceCents)}${marker}`;
  });
  if (set.unavailable.length > 0) lines.push(`Unavailable right now: ${set.unavailable.join(", ")}`);
  if (set.quotes.length === 0) lines.push("No shipping options are available for this address.");
  return lines;
}

function toDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
