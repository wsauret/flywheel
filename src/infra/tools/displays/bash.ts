import { shellDetail } from "../detail-helpers.js";
import { shellSentence } from "../shell-sentence.js";
import type { ToolDisplay } from "../types.js";
import type { ToolPresentation } from "../../output-blocks.js";

const FILE_CHANGE_VERBS = new Set(["Edited", "Wrote", "Formatted", "Moved", "Removed", "Copied", "Created"]);

/** A command declared to change project files is an edit, whatever runs it.
 *  The sentence names the files the command itself names; once the changes
 *  land, workflow activity names the files they changed instead. */
function mutationSentence(sentence: ToolPresentation): ToolPresentation {
  if (FILE_CHANGE_VERBS.has(sentence.name)) return sentence;
  return { name: "Edited", detail: `files with ${sentence.name === "Ran" ? sentence.detail : `${sentence.name} ${sentence.detail}`}` };
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
  },
  // Recorded tool inputs used `edits` before the mutation contract. Remove this conversion after 2027-04-15.
  declaresMutation: (input) => (input.mutates ?? input.edits) === true,
  getDetail: shellDetail,
  getSentence: (input, cwd) => {
    const sentence = shellSentence(shellDetail(input, cwd) ?? "");
    return (input.mutates ?? input.edits) === true ? mutationSentence(sentence) : sentence;
  },
};
