import { formatDuration } from "../../protocol/client/format.js";
import type { AfterToolCallHook } from "./agent-loop-tools.js";
import { parseBashResultDetails } from "./tools/bash.js";
import { foregroundCommandLifetime } from "./tools/bash-guidance.js";

const LONG_STEP_THRESHOLD_MS = 90_000;
const SIGNATURE_MAX_CHARS = 160;
const ERROR_LINE_RE = /^(error\b|.*\berror:|traceback|panic:|fatal:|assertion)/i;


function errorSignature(content: string, exitCode: number): string {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => ERROR_LINE_RE.test(line));
  if (errorLine) return errorLine.slice(0, SIGNATURE_MAX_CHARS);
  // No recognizable error line: fingerprint the leading output so only
  // identical-looking failures count as the same error. Distinct failures
  // that happen to share an exit code (e.g. successive different compile
  // errors, both exit 2) must not trip the repeated-error note.
  return `exit:${exitCode}:${lines.slice(0, 3).join("|")}`.slice(0, SIGNATURE_MAX_CHARS);
}

/**
 * Appends one-shot corrective notes to bash results when a recurring failure
 * pattern surfaces: the same error family on consecutive commands, or a
 * single command consuming a large slice of wall clock. Complements the
 * repetition guard, which watches for repeated identical tool *inputs*;
 * this hook watches repeated failure *outcomes* across differing commands.
 *
 * State is scoped to one agent loop run. The long-step note fires at most
 * once per run; the repeated-error note fires at most once per failure
 * streak (a success re-arms it), so the model is nudged exactly when the
 * pattern appears and never nagged afterward.
 */
export function createExecutionNotesHook(): AfterToolCallHook {
  let lastSignature: string | null = null;
  let repeats = 0;
  const emitted = new Set<string>();

  return (call, result, context) => {
    if ((context.toolNames?.logical(call.name) ?? call.name) !== "bash" || typeof result.content !== "string") return result;
    const { exitCode, durationMs } = parseBashResultDetails(result.details ?? {});
    // Background launches, blocked commands, and policy rejections carry no
    // exit code; they are not execution evidence either way.
    if (exitCode === undefined) return result;

    if (exitCode === 0) {
      lastSignature = null;
      repeats = 0;
      // A success ends the failure streak. Re-arm the note so a genuinely
      // new streak later in a long-lived run (chat runners span a whole
      // session) can nudge again; each streak still fires at most once.
      emitted.delete("repeated_error");
    } else {
      const signature = errorSignature(result.content, exitCode);
      repeats = signature === lastSignature ? repeats + 1 : 1;
      lastSignature = signature;
    }

    let note: string | undefined;
    if (repeats >= 2 && !emitted.has("repeated_error")) {
      emitted.add("repeated_error");
      note = "the same error has now occurred twice in a row. Stop retrying this command pattern; re-read the error, check your assumptions, and switch to a different approach.";
    } else if (durationMs !== undefined && durationMs >= LONG_STEP_THRESHOLD_MS && !emitted.has("long_step")) {
      emitted.add("long_step");
      note = `this command consumed ${formatDuration(durationMs)} of wall clock. Keep finite work in the foreground. ${foregroundCommandLifetime(context.capabilityAccess?.unattended === true)} Use background mode only for a server or service that must remain running. For risky probes, set a tighter timeout.`;
    }
    if (!note) return result;

    return { ...result, content: `${result.content}\n\nExecution note: ${note}` };
  };
}
