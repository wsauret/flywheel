export interface Client {
  readonly id: string;
  readonly name: string;
  readonly plan: "standard" | "retainer";
  readonly hourlyRateCents: number;
}
