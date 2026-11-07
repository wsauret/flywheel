/**
 * Output truncation for tool results.
 *
 * Two paths converge here:
 *  - **Semantic drop**: the tool dropped data on its own (search exceeds
 *    its match limit, bash compression strips passing tests). The tool
 *    sets `fullContent` on its result, which we save verbatim, or names a
 *    file it already retained in `retainedFullContent`, which we name
 *    without writing anything.
 *  - **Byte cap**: the displayed `content` exceeds 30KB. We head+tail
 *    truncate and save the original `content` as the breadcrumb.
 *
 * Either way the saved file lives under
 * `.flywheel/agent-outputs/<artifactScopeId>/<toolName>_<ts>_<id>.txt`, and a
 * single recovery notice is appended to the returned text. Aged-out
 * breadcrumbs are swept project-wide by `session/session-artifacts.ts`; a
 * resumed session's durable transcript can still instruct the model to read a
 * breadcrumb written before the runner that created it exited.
 */

import { displayRelativePath } from "../../../infra/tools/detail-helpers.js";
import type { LlmToolOutputPart } from "../llm/messages.js";
import type { ContentBlock } from "../llm/types.js";
import { truncateHeadTail } from "../../../infra/output/truncate-output.js";
import { saveFullOutput } from "../tools/output-breadcrumb.js";
import type { RetainedFullContent } from "../tools/types.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";

const DEFAULT_MAX_BYTES = 30_000;

const UNAVAILABLE_REST = "The rest of the output is not available with your tools.";

/** The ways that the reading agent's tools can retrieve a saved output file, most precise first
 *  (ARCH-CONTEXT-033). */
interface RetrievalWays {
  readonly search: boolean;
  readonly read: boolean;
  readonly shell: boolean;
}

function retrievalWays(has: CapabilityCheck): RetrievalWays {
  return { search: has("search"), read: has("read"), shell: has("bash") };
}

interface LimitOutputOptions {
  content: string;
  /** Pre-drop original when the tool emitted a lossy view. Saved verbatim
   *  to the breadcrumb file regardless of byte-cap state. */
  fullContent?: string;
  /** A file the tool already retained with the full payload. The notice
   *  names it, and no breadcrumb is written. */
  retainedFullContent?: RetainedFullContent;
  /** Bound of the returned text, recovery notice included. */
  maxBytes?: number;
  executionCwd: string;
  projectRoot: string;
  /** Breadcrumb tree the dropped payload is saved into. */
  artifactScopeId: string;
  /** Used as the breadcrumb filename prefix. Defaults to "output". */
  toolName?: string;
  /** The agent check of the agent that reads the result, which decides how the notice says to retrieve the saved
   *  file. Absent: the reader's tools are unknown, such as in crash recovery, so the notice names the file and no
   *  tool. */
  capabilities?: CapabilityCheck;
}

interface LimitedOutput {
  text: string;
  truncated: boolean;
  semanticTruncated: boolean;
  byteTruncated: boolean;
  fullContentPath?: string;
}

export async function limitOutput(
  options: LimitOutputOptions,
): Promise<LimitedOutput> {
  const {
    content,
    fullContent,
    retainedFullContent,
    maxBytes = DEFAULT_MAX_BYTES,
    executionCwd,
    projectRoot,
    artifactScopeId,
    toolName = "output",
    capabilities,
  } = options;

  const semanticDrop = fullContent !== undefined || retainedFullContent !== undefined;
  if (!semanticDrop && Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return {
      text: content,
      truncated: false,
      semanticTruncated: false,
      byteTruncated: false,
    };
  }

  const savedPath = retainedFullContent?.path ?? await saveFullOutput(fullContent ?? content, toolName, projectRoot, artifactScopeId);
  const notice = savedPath
    ? savedOutputNotice(displayRelativePath(savedPath, executionCwd), capabilities)
    // Breadcrumb write failed: every shell drop still shows its own inline
    // marker, and this notice states that no recovery file exists.
    : "[Output was truncated and the full output could not be saved to disk]";
  // The notice names a path of any length, so the kept content gets only the room it leaves.
  const capped = headTailWithin(content, maxBytes - Buffer.byteLength(notice, "utf-8") - 1);
  return {
    text: capped.text ? `${capped.text}\n${notice}` : notice,
    truncated: true,
    semanticTruncated: semanticDrop,
    byteTruncated: capped.truncated,
    ...(savedPath ? { fullContentPath: savedPath } : {}),
  };
}

function savedOutputNotice(path: string, has: CapabilityCheck | undefined): string {
  if (has === undefined) return `[Full output saved to ${path}]`;
  const ways = retrievalWays(has);
  const way = ways.search ? "grep it with the search tool" : ways.read ? "read it with offset and limit" : ways.shell ? "inspect it with a shell command" : undefined;
  return way ? `[Full output saved to ${path}; ${way} if you need the removed content]` : `[Output was truncated. ${UNAVAILABLE_REST}]`;
}

/** The head and tail of `content` around its omission marker, marker
 *  included within `maxBytes`. Empty when no head and tail fit. */
function headTailWithin(content: string, maxBytes: number) {
  const byteLen = Buffer.byteLength(content, "utf-8");
  if (byteLen <= maxBytes) return { text: content, truncated: false };
  // The marker can name at most every byte as omitted, so this length bounds it.
  const markerBytes = `\n[... ${byteLen} bytes omitted ...]\n`.length;
  const portion = Math.floor((maxBytes - markerBytes) / 2);
  return { text: portion > 0 ? truncateHeadTail(content, maxBytes, portion).text : "", truncated: true };
}

// ── Aggregate per-turn tool-output budget ─────────────────────────
//
// `limitOutput` above is the per-result layer (a 30KB cap); this is the
// turn layer: a batch of individually legal results can still land 10-30k
// tokens in one hop, so when the batch total exceeds the budget the largest
// results are replaced, largest first, by a preview block plus the
// breadcrumb path. The caller decides which results are exempt and sizes the
// budget from the one context admission budget in compaction-policy.ts.

const PREVIEW_SIZE_CHARS = 1_500;
const PERSISTED_OUTPUT_TAG = "<persisted-output>";

export interface TurnBudgetEntry {
  toolUseId: string;
  toolName: string;
  /** Exempt entries count toward the total but are never persisted. */
  exempt: boolean;
  content: LlmToolOutputPart[];
  /** Breadcrumb already written for this result (byte cap or semantic drop).
   *  Reused as the persistence target instead of writing a second file; it
   *  holds the pre-truncation original, a superset of the in-context text. */
  fullContentPath?: string;
}

export interface TurnBudgetReplacement {
  toolUseId: string;
  content: LlmToolOutputPart[];
}

/** Layer 3: enforce the aggregate budget across one batch's results. Returns
 *  the replacements to apply (empty when the batch is under budget). Pure with
 *  respect to its inputs; the caller applies the replacements. */
export async function enforceTurnBudget(
  entries: ReadonlyArray<TurnBudgetEntry>,
  options: { budgetChars: number; executionCwd: string; projectRoot: string; artifactScopeId: string; capabilities?: CapabilityCheck },
): Promise<TurnBudgetReplacement[]> {
  const budget = options.budgetChars;
  const sized = entries.map((entry) => ({ entry, chars: textChars(entry.content) }));
  let total = sized.reduce((sum, item) => sum + item.chars, 0);
  if (total <= budget) return [];

  const candidates = sized
    .filter(({ entry, chars }) => !entry.exempt && chars > PREVIEW_SIZE_CHARS && !containsPersistedTag(entry.content))
    .sort((a, b) => b.chars - a.chars);

  const replacements: TurnBudgetReplacement[] = [];
  for (const { entry, chars } of candidates) {
    if (total <= budget) break;
    const text = joinTextParts(entry.content);
    const savedPath = entry.fullContentPath
      ?? await saveFullOutput(text, entry.toolName, options.projectRoot, options.artifactScopeId);
    const block = persistedPreviewBlock(text, savedPath ? displayRelativePath(savedPath, options.executionCwd) : null, options.capabilities);
    const imageParts = entry.content.filter((part) => part.type === "image");
    replacements.push({ toolUseId: entry.toolUseId, content: [{ type: "text", text: block }, ...imageParts] });
    total = total - chars + block.length;
  }
  return replacements;
}

/** Preview at the last newline within the cap. */
function generatePreview(content: string) {
  if (content.length <= PREVIEW_SIZE_CHARS) return { preview: content, hasMore: false };
  let truncated = content.slice(0, PREVIEW_SIZE_CHARS);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > PREVIEW_SIZE_CHARS / 2) truncated = truncated.slice(0, lastNewline + 1);
  return { preview: truncated, hasMore: true };
}

function persistedPreviewBlock(text: string, savedPath: string | null, has: CapabilityCheck | undefined): string {
  const { preview, hasMore } = generatePreview(text);
  const ways = has === undefined ? undefined : retrievalWays(has);
  const retrieval = ways === undefined ? undefined : [...(ways.read ? ["read that file with offset/limit"] : []), ...(ways.search ? ["grep it with the search tool"] : []), ...(!ways.read && !ways.search && ways.shell ? ["inspect it with a shell command"] : [])].join(", or ");
  const lines = [
    PERSISTED_OUTPUT_TAG,
    `This tool result was too large for the turn's aggregate tool-output budget (${text.length} chars).`,
    ...(savedPath
      ? [
          `Full output saved to: ${savedPath}`,
          ...(retrieval === undefined ? [] : [retrieval ? `${retrieval.charAt(0).toUpperCase()}${retrieval.slice(1)}, to access specific sections.` : UNAVAILABLE_REST]),
        ]
      : ["The full output could not be saved to disk; the preview below is all that was preserved."]),
    "",
    `Preview (first ${preview.length} chars):`,
    preview + (hasMore ? "\n..." : ""),
    "</persisted-output>",
  ];
  return lines.join("\n");
}

function containsPersistedTag(content: ReadonlyArray<LlmToolOutputPart>): boolean {
  return content.some((part) => part.type === "text" && part.text.includes(PERSISTED_OUTPUT_TAG));
}

/** The text characters of tool output or message content; images count none. */
export function textChars(content: ReadonlyArray<LlmToolOutputPart | ContentBlock>): number {
  return content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}

function joinTextParts(content: ReadonlyArray<LlmToolOutputPart>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}