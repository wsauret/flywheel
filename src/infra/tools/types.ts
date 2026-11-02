import type { ToolPresentation } from "../output-blocks.js";
import type { LlmToolOutputPart } from "../llm/tool-output-part-schema.js";
import type { StandaloneHandler } from "../output/output-tool-projection-types.js";
import type { ToolAction } from "../workflow-types.js";

export type { ToolPresentation };

export type ToolDiffInfo = {
  diff?: string;
  content?: string;
  filetype?: string;
};

/** One resolved presentation, or `"input_not_ready"` when the invocation input
 * does not yet name an operation. Visible calls use the display's neutral name
 * until enough declared input exists to refine the same stable row. */
export type ToolPresentationResolution = ToolPresentation | "input_not_ready";

/** Retained target metadata supplied by the transcript owner, never tool input. */
export interface ToolPresentationContext {
  targetDescription?: string;
}

interface ToolInput {
  [key: string]: unknown;
}

interface ToolStreamingBodyFields {
  readonly [field: string]: "content" | "diff";
}

interface ToolStreamingInput {
  /** Top-level string fields that can own the live row body. Field presence
   * selects the body, so one display can cover distinct input shapes. */
  bodyFields: ToolStreamingBodyFields;
  /** Top-level fields whose values can refine the row presentation: a string
   *  field as it streams, and a boolean or object field once it completes. */
  presentationFields: readonly string[];
}

/** Presentation contract for a tool: verbs, detail formatting, and render-path hints the output layer and TUI need without consulting orchestration. */
interface ToolDisplayBase {
  name: string;
  /** How a call of this tool presents: the one value every client renders
   *  and groups by. The projection copies it onto each row as the wire
   *  field `action`, and `toolRunCategoryFor` maps it to a group. It can
   *  differ on purpose from the `action` the tool declares in orchestration,
   *  which decides grants, persona `excludeActions`, the system prompt, and
   *  output budgets: `skill` is bookkeeping there but presents as a read. */
  action: ToolAction;
  displayName: string;
  verbs: { progressive: string; past: string; blocked?: string };
  /** A compact call sentence for workflow activity, separate from the transcript row. */
  getSentence?: (input: ToolInput, executionCwd: string, presentation: ToolPresentation) => ToolPresentation;
  extractDiff?: (input: ToolInput, executionCwd: string) => ToolDiffInfo | undefined;
  /** Declares a filesystem proposal. Registered file tools use the canonical
   * proposal fields instead of raw invocation bodies or preview fields. */
  fileChangeKind?: "create" | "replace" | "patch" | ((input: ToolInput) => "create" | "replace" | "patch");
  /** Whether a call's input declares that it edits project files. Such a call
   *  presents as a file edit from the moment the declaration streams, though
   *  it proposes no diff: its changes are known only once they land. */
  declaresMutation?: (input: ToolInput) => boolean;
  /** The session a call addresses, which its row names. The transcript
   *  projection names the row by that session's current display name. */
  targetSession?: (input: ToolInput) => string | undefined;
  /** Invocation input rendered either inline or only after row disclosure. */
  invocationBody?: (input: ToolInput) => { content: string; filetype: string; presentation?: "disclosure" } | undefined;
  streamingInput?: ToolStreamingInput;
  preservesResultContent?: boolean;
  resultLinkUri?: (content: LlmToolOutputPart[] | undefined) => string | undefined;
  standaloneHandler?: StandaloneHandler;
  /** Prose the call carries for the user, rendered as a plain text block
   *  immediately before the tool's own block (ask_user's `context`). The
   *  live standaloneHandler and the derived-history projection both read it,
   *  so one input renders the same on both paths. */
  leadingText?: (input: ToolInput) => string | undefined;
  isOptimistic: boolean;
  /** Presentation only: render this tool as an agent-like block instead of a
   *  normal tool row. Runtime scheduling and trace classification live on
   *  `RuntimeTool.execution`, not in this display contract. */
  rendersAsAgentBlock?: boolean | ((input: ToolInput) => boolean);
  /** Model control plumbing: such a call never renders in the user
   *  transcript, regardless of result. A predicate hides only the calls
   *  whose input it names, so a tool can show its consequential actions. */
  hiddenFromTranscript?: boolean | ((input: ToolInput) => boolean);
  /** A completed row's body is the recorded execution-output tail whenever one
   *  was recorded, not the model-facing result text. */
  resultContentFromExecutionOutput?: boolean;
}

/** A tool whose actions are distinct user-facing operations: one resolver names
 *  the operation and its arguments together, so no second interpreter of the
 *  same action can disagree. `displayName` is the neutral family name a call
 *  that names no known action falls back to. */
interface ActionAwareToolDisplay extends ToolDisplayBase {
  getPresentation: (input: ToolInput, executionCwd: string, context?: ToolPresentationContext) => ToolPresentationResolution;
  getDetail?: never;
}

/** A tool with one operation: `displayName` plus an argument-only detail. */
export interface DetailToolDisplay extends ToolDisplayBase {
  getDetail: (input: ToolInput, executionCwd: string) => string | null;
  getPresentation?: never;
}

export type ToolDisplay = ActionAwareToolDisplay | DetailToolDisplay;
