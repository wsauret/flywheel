import { singleLine, strField } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

/** The experiment tools: starting and settling an experiment are bookkeeping,
 *  and a measurement run is a command whose output the row keeps. */
export const experimentDisplays: readonly ToolDisplay[] = [
  {
    name: "init_experiment",
    action: "ui_meta",
    displayName: "Start Experiment",
    verbs: { progressive: "Starting experiment", past: "Started experiment" },
    isOptimistic: false,
    getDetail: (input) => singleLine(strField(input, "name") ?? "") ?? null,
  },
  {
    name: "run_experiment",
    action: "shell_exec",
    displayName: "Run Experiment",
    verbs: { progressive: "Running experiment", past: "Ran experiment" },
    isOptimistic: false,
    preservesResultContent: true,
    getDetail: () => null,
  },
  {
    name: "log_experiment",
    action: "ui_meta",
    displayName: "Log Experiment",
    verbs: { progressive: "Logging experiment", past: "Logged experiment" },
    isOptimistic: false,
    getDetail: (input) => {
      const status = strField(input, "status")?.replaceAll("_", " ");
      const description = singleLine(strField(input, "description") ?? "");
      return [status, description].filter(Boolean).join(": ") || null;
    },
  },
];
