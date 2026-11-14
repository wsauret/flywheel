/** An ISO calendar date, `YYYY-MM-DD`; fixed-width, so two dates compare correctly as strings. */
export type IsoDate = string;

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The same day `months` later; a day that does not exist in the target month becomes that month's last day (2028-02-29 plus 12 months is 2029-02-28). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
