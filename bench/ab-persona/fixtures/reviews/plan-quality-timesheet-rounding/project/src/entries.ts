export interface TimeEntry {
  readonly id: string;
  readonly clientId: string;
  /** ISO date, for example "2027-02-03". */
  readonly date: string;
  readonly description: string;
  readonly minutes: number;
  readonly billable: boolean;
}
