import type { FieldMap } from "./grammar.js";

/** The envelope every agent output carries beside its declared fields (plan
 *  section 2.2). The handoff tool, the postamble, the generic renderer, and
 *  artifact context import this one definition. */

const COMMAND_RUNS_DESCRIPTION = "The Bash commands whose results prove this handoff's claims. Cite the ones that matter, not every command you ran. Each completed foreground Bash result ends with its model-visible [toolUseId: ...] citation. Copy that id into toolUseId. The runtime records the command and its exit code from the cited call. observation is your trusted concise account of the output; ground it in what the command returned.";

export const COMMAND_EVIDENCE_RULE = "**Command execution is recorded from the calls you cite; result descriptions are trusted reports.** Cite the Bash commands that prove your claims by their exact toolUseId; the runtime records each command and its exit code from the cited call. Never improve, infer, or fabricate evidence. A later agent re-runs commands only when its brief explicitly requires fresh verification.";

const defaultSummaryDescription = "Open with one short sentence, under ten words, that states the result. Then describe what you did and the current state.";

/** The envelope keys as grammar fields. `commands_run` is optional here; a
 *  contract's `commands.min` makes it required. The boundary fills
 *  `command`, `exitCode`, `cwd`, and `changedAfter` from the cited call, so
 *  the model-facing envelope leaves them out. */
export const envelope = {
  summary: { type: "string", description: defaultSummaryDescription },
  commands_run: {
    type: "list",
    optional: true,
    description: COMMAND_RUNS_DESCRIPTION,
    example: [{ toolUseId: "toolu_abc123", observation: "12 tests passed" }],
    of: {
      type: "object",
      fields: {
        toolUseId: { type: "string", description: "The id from the [toolUseId: ...] line that ends the cited Bash result." },
        exitCode: { type: "number", description: "The exit code of the cited call. The runtime records it from the cited call." },
        observation: { type: "string", description: "A concise account of what the command returned." },
        command: { type: "string", description: "The command that ran. The runtime records it from the cited call." },
        // `cwd` and `changedAfter` are optional only for outputs stored before
        // 2026-10-26, which lack both keys; the writer always sets them.
        // Remove the optionality after 2027-04-26.
        cwd: { type: "string", optional: true, description: "The absolute directory that the cited call named. The runtime records it from the cited call." },
        changedAfter: {
          type: "list",
          optional: true,
          description: "Each file that changed in the agent's session after the cited call. The runtime records it.",
          of: { type: "string" },
        },
      },
    },
  },
  files_modified: {
    type: "list",
    optional: true,
    description: "Workspace-relative paths of the files you created or changed.",
    of: { type: "string" },
  },
} as const satisfies FieldMap;

/** Keys of a command-run record that the boundary records from the cited
 *  call. The model never sends them, and a value it sends is ignored. */
export const recordedCommandRunKeys = ["command", "exitCode", "cwd", "changedAfter"] as const;

export type RecordedCommandRunKey = typeof recordedCommandRunKeys[number];

/** The payload fields as the model fills them: each cited run without the
 *  keys the boundary records. The tool input schema and the postamble both
 *  read this one view. */
export function modelFacingFields(fields: FieldMap): FieldMap {
  const commandsRun = fields.commands_run;
  const item = commandsRun?.of;
  if (!commandsRun || !item?.fields) return fields;
  const cited = Object.fromEntries(Object.entries(item.fields).filter(([key]) => !recordedCommandRunKeys.some((recorded) => recorded === key)));
  return { ...fields, commands_run: { ...commandsRun, of: { ...item, fields: cited } } };
}
