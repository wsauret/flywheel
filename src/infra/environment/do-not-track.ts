/** Whether a `DO_NOT_TRACK` value asks software to send no automatic
 *  telemetry. The convention counts `1` and `true`; any other value, and an
 *  unset variable, does not opt out. */
export function doNotTrack(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true"
}
