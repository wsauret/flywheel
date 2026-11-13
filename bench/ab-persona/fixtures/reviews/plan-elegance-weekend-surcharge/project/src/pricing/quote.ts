import { BASE_FEE_CENTS, BULKY_FEE_CENTS, PER_KM_CENTS } from "./rates";

export interface DeliveryRequest {
  readonly distanceKm: number;
  readonly bulky: boolean;
}

export interface QuoteLine {
  readonly label: string;
  readonly cents: number;
}

export interface Quote {
  readonly lines: readonly QuoteLine[];
  readonly totalCents: number;
}

/** The price of one delivery, line by line. `now` is the pickup time; the service runs with TZ set to the courier's zone, so local Date methods read local time. */
export function quoteDelivery(request: DeliveryRequest, now: Date): Quote {
  const lines: QuoteLine[] = [
    { label: "Base fee", cents: BASE_FEE_CENTS },
    { label: "Distance", cents: Math.round(request.distanceKm * PER_KM_CENTS) },
  ];
  if (request.bulky) lines.push({ label: "Bulky item", cents: BULKY_FEE_CENTS });
  void now;
  return { lines, totalCents: lines.reduce((sum, line) => sum + line.cents, 0) };
}
