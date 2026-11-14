import type { AppointmentStore } from "../appointments";
import type { Clinic } from "../clinics";
import type { Mailer } from "../email/mailer";
import { formatSlot } from "../format";
import type { Patient } from "../patients/patients";

export interface ReminderDeps {
  readonly appointments: AppointmentStore;
  readonly patient: (id: string) => Promise<Patient>;
  readonly clinic: (id: string) => Promise<Clinic>;
  readonly mailer: Mailer;
  /** Called once for each appointment whose reminder failed; the pass goes on with the next one. */
  readonly reportFailure: (appointmentId: string, error: unknown) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PASS_INTERVAL_MS = 15 * 60 * 1000;

/** Remind every appointment that starts 24 hours from now, within one pass interval.
 *  Each appointment is marked reminded after its messages go out, so it gets one pass.
 *  Returns the number of appointments the pass handled without a failure. */
export async function runReminderPass(deps: ReminderDeps, now: Date): Promise<number> {
  const from = new Date(now.getTime() + DAY_MS);
  const to = new Date(from.getTime() + PASS_INTERVAL_MS);
  const due = await deps.appointments.unremindedStartingBetween(from, to);
  let reminded = 0;
  for (const appointment of due) {
    try {
      const [patient, clinic] = await Promise.all([deps.patient(appointment.patientId), deps.clinic(appointment.clinicId)]);
      if (patient.email !== undefined) {
        await deps.mailer.send(
          patient.email,
          `Your appointment at ${clinic.name}`,
          `Dear ${patient.name}, this is a reminder of your appointment at ${clinic.name} on ${formatSlot(appointment.startsAt)}.`,
        );
      }
      await deps.appointments.markReminded(appointment.id, now);
      reminded++;
    } catch (error) {
      deps.reportFailure(appointment.id, error);
    }
  }
  return reminded;
}
