import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatEventTime, weekdayHeadings } from "./calendar.ts";
import { parseSettingsFile } from "./settings-file.ts";

const SETTINGS_PATH = join(homedir(), ".config", "deskcal", "settings.json");

/** Print the week header and the current time, as the status bar shows them. */
export function main(): void {
  const settings = parseSettingsFile(SETTINGS_PATH, readIfPresent(SETTINGS_PATH));
  console.log(weekdayHeadings(settings).join(" "));
  console.log(formatEventTime(Date.now(), settings));
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
