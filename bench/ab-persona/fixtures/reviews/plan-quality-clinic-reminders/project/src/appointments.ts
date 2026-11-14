export interface Appointment {
  readonly id: string;
  readonly patientId: string;
  readonly clinicId: string;
  readonly startsAt: Date;
  /** When the reminder pass handled this appointment; absent until then. */
  readonly remindedAt?: Date;
}

export interface AppointmentStore {
  /** Appointments that start in [from, to) and have no remindedAt. */
  unremindedStartingBetween(from: Date, to: Date): Promise<readonly Appointment[]>;
  markReminded(id: string, at: Date): Promise<void>;
}
