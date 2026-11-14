import type { Appointment } from "../src/appointments";
import type { Clinic } from "../src/clinics";
import type { Patient } from "../src/patients/patients";
import type { ReminderDeps } from "../src/reminders/pass";

export interface Sent {
  readonly to: string;
  readonly text: string;
}

export function fakeDeps(input: { appointments: Appointment[]; patients: Patient[]; clinics: Clinic[] }): ReminderDeps & { readonly emails: Sent[]; readonly failures: string[] } {
  const emails: Sent[] = [];
  const failures: string[] = [];
  const appointments = input.appointments;
  return {
    emails,
    failures,
    appointments: {
      unremindedStartingBetween: async (from, to) =>
        appointments.filter((a) => a.remindedAt === undefined && a.startsAt >= from && a.startsAt < to),
      markReminded: async (id, at) => {
        const index = appointments.findIndex((a) => a.id === id);
        const current = appointments[index];
        if (current !== undefined) appointments[index] = { ...current, remindedAt: at };
      },
    },
    patient: async (id) => {
      const found = input.patients.find((p) => p.id === id);
      if (found === undefined) throw new Error(`Unknown patient ${id}`);
      return found;
    },
    clinic: async (id) => {
      const found = input.clinics.find((c) => c.id === id);
      if (found === undefined) throw new Error(`Unknown clinic ${id}`);
      return found;
    },
    mailer: { send: async (to, _subject, body) => { emails.push({ to, text: body }); } },
    reportFailure: (appointmentId) => { failures.push(appointmentId); },
  };
}
