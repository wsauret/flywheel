import { isSessionId } from "../../session-id.js";
import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The row name of a control of a child session, or nothing for any other
 *  call. Interrupt and resume act on children only. A stop acts on a child
 *  when its process id is a session id; a stop of a command, as history
 *  from before children were processes holds, stays model plumbing. */
function controlName(input: Parameters<typeof strField>[0]): string | undefined {
  switch (strField(input, "action")) {
    case "interrupt": return "Interrupt";
    case "resume": return "Resume";
    case "stop": return isSessionId(strField(input, "process_id") ?? "") ? "Stop" : undefined;
    default: return undefined;
  }
}

/** The work an agent started. Its reads, waits, and command stops are model
 *  plumbing; its interrupt, resume, and stop of its own child show a row, so
 *  a person sees what the agent did to its child. The row names the action
 *  and its target by name or goal, as a message row does. */
export const processDisplay: ToolDisplay = {
  name: "process",
  action: "ui_meta",
  displayName: "Process",
  verbs: { progressive: "Managing processes", past: "Managed processes" },
  isOptimistic: false,
  hiddenFromTranscript: (input) => controlName(input) === undefined,
  targetSession: (input) => controlName(input) ? strField(input, "process_id") || undefined : undefined,
  getPresentation: (input, _executionCwd, context) => {
    const name = controlName(input);
    if (!name) return { name: "Process", detail: strField(input, "action") ?? "" };
    const id = strField(input, "process_id");
    if (!id) return "input_not_ready";
    return { name, detail: singleLine(context?.targetDescription ?? id) ?? id };
  },
  getSentence: (input, _executionCwd, presentation) => {
    const target = controlName(input) ? presentation.detail : strField(input, "process_id");
    switch (strField(input, "action")) {
      case "wait": return { name: "Waited", detail: `for ${target ?? "processes"}` };
      case "read_output": return { name: "Read", detail: `output of ${target ?? "a process"}` };
      case "stop": return { name: "Stopped", detail: target ?? "a process" };
      case "interrupt": return { name: "Interrupted", detail: target ?? "" };
      case "resume": return { name: "Resumed", detail: target ?? "" };
      case "list": return { name: "Listed", detail: "processes" };
      default: return { name: "Checked", detail: target ?? "processes" };
    }
  },
};
