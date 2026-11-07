import type { ConfigReadResult } from "./config-file.js";
import type { RuntimeConfigOwner } from "./runtime-config-owner.js";

/** Reads `shell_write_guard` from the config file each time the shell checks
 *  a command, through the owner's use-time observer, so a setting saved
 *  mid-session applies to the next command. A missing, refused, unparseable,
 *  or invalid file keeps the guard on: only an authored `false` turns it off. */
export function shellWriteGuardObserver(owner: Pick<RuntimeConfigOwner, "useTimeObserver">): () => Promise<boolean> {
  return owner.useTimeObserver(decodeShellWriteGuard);
}

function decodeShellWriteGuard(read: ConfigReadResult): boolean {
  if (read.kind !== "text") return true;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read.text);
  } catch {
    return true;
  }
  return !(typeof parsed === "object" && parsed !== null && "shell_write_guard" in parsed && parsed.shell_write_guard === false);
}
