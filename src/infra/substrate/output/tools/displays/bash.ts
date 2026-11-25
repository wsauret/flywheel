import { createPresentationTextSanitizer, sanitizePresentationText } from "../../control-characters.js";
import { shellCommandDisplay, shellDetail, ShellDetailStream, strField, type ShellDetailStep, type ToolInput } from "../detail-helpers.js";
import { ShellSentenceFold } from "../shell-sentence.js";
import type { StreamingRowDerivation, ToolDisplay } from "../types.js";
import type { ToolPresentation } from "../../../events/output-blocks.js";

const FILE_CHANGE_VERBS = new Set(["Edited", "Wrote", "Formatted", "Moved", "Removed", "Copied", "Created"]);
const SCRIPT_RUNNER = "bash ";

// Recorded tool inputs used `edits` before the mutation contract. Remove this conversion after 2027-04-15.
const declaresMutation = (input: ToolInput): boolean => (input.mutates ?? input.edits) === true;

/** A command declared to change project files is an edit, whatever runs it.
 *  The sentence names the files the command itself names; once the changes
 *  land, workflow activity names the files they changed instead. */
function mutationSentence(sentence: ToolPresentation): ToolPresentation {
  if (FILE_CHANGE_VERBS.has(sentence.name)) return sentence;
  const ran = sentence.name === "Ran" ? sentence.detail : `${sentence.name} ${sentence.detail}`;
  return { name: "Edited", detail: ran === "" ? "files" : `files with ${ran}` };
}

/** The row of a streaming command. Only the text that a delta adds is
 *  shortened, scanned, and sanitized, so the visible command grows by each
 *  delta. A script gains its `bash ` once the command that runs it is read:
 *  the row then sanitizes again from the start of the top-level command,
 *  where it holds the sanitizer's state, so an escape sequence open across
 *  the script's start reads as it does in the settled command. The sentence
 *  changes only when a command is read: it folds the complete commands, and
 *  the commands that wait for their heredoc bodies stand in until those
 *  arrive. After the last delta the row equals `resolveToolRowPresentation`
 *  of the whole input. */
function streamingShellRow(executionCwd: string): StreamingRowDerivation {
  const stream = new ShellDetailStream(executionCwd);
  let sanitizer = createPresentationTextSanitizer();
  /** The sanitizer's state and the detail's length at the scanner's floor. */
  let floor = { offset: 0, state: sanitizer.state(), length: 0 };
  /** Where the scripts at or after the floor start, in order. */
  let scripts: number[] = [];
  let detail = "";
  const fold = new ShellSentenceFold();
  let waiting = 0;
  let composed: ToolPresentation | undefined;
  let shown: { readonly from: ToolPresentation | undefined; readonly mutates: boolean; readonly sentence: ToolPresentation } | undefined;
  let ended = false;

  /** Sanitizes the shortened command between two offsets, with the runner
   *  before each script that starts there, as the settled detail has it. */
  const feed = (from: number, to: number): void => {
    let copied = from;
    for (const start of scripts) {
      if (start < from || start >= to) continue;
      detail += sanitizer.push(stream.slice(copied, start) + SCRIPT_RUNNER);
      copied = start;
    }
    detail += sanitizer.push(stream.slice(copied, to));
  };

  const apply = (step: ShellDetailStep): void => {
    const end = stream.end;
    let from = end - step.text.length;
    if (step.scripts.length > 0) {
      scripts = [...scripts, ...step.scripts].sort((left, right) => left - right);
      sanitizer = createPresentationTextSanitizer(floor.state);
      detail = detail.slice(0, floor.length);
      from = floor.offset;
    }
    if (step.floor > floor.offset) {
      feed(from, step.floor);
      floor = { offset: step.floor, state: sanitizer.state(), length: detail.length };
      scripts = scripts.filter((start) => start >= step.floor);
      from = step.floor;
    }
    feed(from, end);
    fold.add(step.complete);
    if (step.complete.length > 0 || step.waiting.length !== waiting) {
      waiting = step.waiting.length;
      if (waiting === 0) composed = fold.sentence();
      else {
        const provisional = fold.fork();
        provisional.add(step.waiting);
        composed = provisional.sentence();
      }
    }
  };

  return {
    advance: (additions, fields) => {
      const text = additions.command;
      if (text !== undefined) apply(stream.advance(text));
      // The closing quote ends the command, which completes its last line.
      if (!ended && fields.command !== undefined) {
        ended = true;
        apply(stream.finish());
        // A line with no command presents as itself, which only the whole line can show.
        composed ??= { name: "Ran", detail };
      }
      const mutates = declaresMutation(fields);
      if (shown === undefined || shown.from !== composed || shown.mutates !== mutates) {
        const sentence = composed ?? { name: "Ran", detail: "" };
        const stated = mutates ? mutationSentence(sentence) : sentence;
        shown = { from: composed, mutates, sentence: { name: sanitizePresentationText(stated.name), detail: sanitizePresentationText(stated.detail) } };
      }
      return { presentation: { name: bashDisplay.displayName, detail }, sentence: shown.sentence };
    },
  };
}

export const bashDisplay: ToolDisplay = {
  name: "bash",
  action: "shell_exec",
  displayName: "Bash",
  verbs: { progressive: "Run", past: "Ran" },
  isOptimistic: false,
  preservesResultContent: true,
  resultContentFromExecutionOutput: true,
  streamingInput: {
    bodyFields: {},
    presentationFields: ["mutates", "command"],
    row: streamingShellRow,
  },
  declaresMutation,
  getDetail: shellDetail,
  /** Presents a shell command as what it does: its reads, searches, edits,
   *  and the programs it runs. A command that none of those describe
   *  presents as itself, without its directory changes, environment
   *  wrappers, and output shaping. */
  getSentence: (input, cwd) => {
    const { detail, commands } = shellCommandDisplay(strField(input, "command") ?? "", cwd);
    const fold = new ShellSentenceFold();
    fold.add(commands);
    const sentence = fold.sentence() ?? { name: "Ran", detail };
    return declaresMutation(input) ? mutationSentence(sentence) : sentence;
  },
};
