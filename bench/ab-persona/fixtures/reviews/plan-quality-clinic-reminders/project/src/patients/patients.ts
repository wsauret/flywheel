export interface Patient {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  /** The mobile number as the patient typed it at registration. */
  readonly mobile?: string;
}
