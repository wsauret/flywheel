import { describe, expect, test } from "bun:test";
import { runReminderPass } from "../src/reminders/pass";
import { fakeDeps } from "./fakes";

const clinic = { id: "c-1", name: "Willowbrook North", timeZone: "Europe/London" };
const patient = { id: "p-1", name: "Sam Rivera", email: "sam@example.com", mobile: "07700 900123" };

describe("runReminderPass", () => {
  test("emails an appointment that starts 24 hours from now and marks it reminded", async () => {
    const deps = fakeDeps({
      appointments: [{ id: "a-1", patientId: "p-1", clinicId: "c-1", startsAt: new Date("2027-01-12T09:30:00Z") }],
      patients: [patient],
      clinics: [clinic],
    });
    expect(await runReminderPass(deps, new Date("2027-01-11T09:20:00Z"))).toBe(1);
    expect(deps.emails).toHaveLength(1);
    expect(await runReminderPass(deps, new Date("2027-01-11T09:25:00Z"))).toBe(0);
  });

  test("leaves an appointment outside the window alone", async () => {
    const deps = fakeDeps({
      appointments: [{ id: "a-2", patientId: "p-1", clinicId: "c-1", startsAt: new Date("2027-01-13T09:30:00Z") }],
      patients: [patient],
      clinics: [clinic],
    });
    expect(await runReminderPass(deps, new Date("2027-01-11T09:20:00Z"))).toBe(0);
  });
});
