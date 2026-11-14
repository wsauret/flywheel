# clinic-scheduler

Appointment booking for the Willowbrook family practices. Each practice is a clinic with its own time zone.

- `src/appointments.ts` and `src/clinics.ts` hold the booking data.
- `src/patients/` holds patient records and contact details.
- `src/reminders/pass.ts` is the reminder pass that the scheduler runs every 15 minutes.
- `src/email/mailer.ts` and `src/sms/gateway.ts` are the outbound channels. The SMS gateway is already used for sign-in codes.
- `src/format.ts` formats dates for patient-facing text.

Tests run with `bun test`.
