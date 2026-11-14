export interface Clinic {
  readonly id: string;
  readonly name: string;
  /** An IANA time zone name, for example "America/Denver". */
  readonly timeZone: string;
}
