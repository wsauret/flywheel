/** An ISO calendar date, `YYYY-MM-DD`. Because the format is fixed-width, two dates compare correctly as strings. */
export type IsoDate = string;

/** The date `days` after `date`, across month and year ends. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(time).toISOString().slice(0, 10);
}

/** Today's date in `timeZone`. The en-CA locale writes dates as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
