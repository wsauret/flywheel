import type { QuoteService } from "./quotes.ts";
import { renderShippingOptions } from "./shipping-options.ts";
import type { Parcel } from "./types.ts";

/** The shipping step of checkout: quote the parcel and render the choices. */
export async function shippingStep(service: QuoteService, parcel: Parcel): Promise<string[]> {
  return renderShippingOptions(await service.quoteAll(parcel));
}
