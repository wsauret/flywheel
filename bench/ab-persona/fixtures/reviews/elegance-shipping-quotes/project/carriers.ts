import type { Parcel } from "./types.ts";

/** A carrier rate API. Each client applies its own request timeout, so
 *  quote() always settles: it resolves with a price in cents or rejects. */
export interface Carrier {
  code: string;
  name: string;
  quote(parcel: Parcel): Promise<number>;
}
