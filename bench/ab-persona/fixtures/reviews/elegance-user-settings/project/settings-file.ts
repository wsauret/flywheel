import { DEFAULT_SETTINGS, type Settings, WEEK_STARTS } from "./settings.ts";

/** Parse the user's hand-edited settings file. `text` is undefined when the
 *  file does not exist, which means "all defaults". A field the file leaves
 *  out keeps its default; a misspelled key or a wrong value is an error that
 *  names the file and the key, so a typo never silently does nothing. */
export function parseSettingsFile(path: string, text: string | undefined): Settings {
  if (text === undefined) return { ...DEFAULT_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object`);
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "weekStartsOn") {
      const weekStart = WEEK_STARTS.find((candidate) => candidate === value);
      if (weekStart === undefined) throw new Error(`${path}: weekStartsOn must be one of ${WEEK_STARTS.join(", ")}`);
      settings.weekStartsOn = weekStart;
    } else if (key === "timeZone") {
      if (typeof value !== "string" || !isTimeZone(value)) throw new Error(`${path}: timeZone must be an IANA name such as "Europe/Lisbon"`);
      settings.timeZone = value;
    } else {
      throw new Error(`${path}: unknown setting "${key}"`);
    }
  }
  return settings;
}

/** The runtime's own time zone database is the authority on valid names. */
function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
