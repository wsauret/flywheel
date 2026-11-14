/** Format an appointment start for patient-facing text, for example "Tue 12 Jan 2027, 09:30". */
export function formatSlot(startsAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(startsAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}`;
}
