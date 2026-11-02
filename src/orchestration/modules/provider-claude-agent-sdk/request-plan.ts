import { cliRewritesImage } from "./cli-images.js";
import { identityDifference, sameCliValue, type CliBlock, type CliMessage, type CliView, type PlacedReminder, type QueryIdentity } from "./cli-view.js";

/** The largest result, in characters, that the handler path keeps intact (`maxResultSizeChars` of the server). */
export const HANDLER_RESULT_LIMIT = 500_000;
/** The longest error text, in characters, that the CLI sends unchanged; it cuts out the middle of a longer one. */
const HANDLER_ERROR_LIMIT = 10_000;

/** The conversation that a live query holds: what the bridge pushed and what the model answered. */
export interface CliCopy {
  readonly identity: QueryIdentity;
  readonly messages: readonly CliMessage[];
}

/** The bridge's live query, as the planner needs it. */
export type QueryState =
  | { readonly kind: "released" }
  /** A turn is still in flight. Flywheel sends one request at a time, so this is a defect that a new query fixes. */
  | { readonly kind: "busy" }
  /** The query's copy no longer matches what the model saw: an interrupt, a hidden request, or a stop. */
  | { readonly kind: "poisoned" }
  | { readonly kind: "idle"; readonly copy: CliCopy }
  /** The query waits in MCP handlers for these tool results. */
  | { readonly kind: "parked"; readonly copy: CliCopy; readonly toolUseIds: readonly string[] };

/** Why a request needs a new query. The bridge records it as the rotation trigger. */
type StartTrigger =
  | { readonly kind: "first-request" | "released" | "busy" | "poisoned" | "history" | "tail" | "result-ids" | "results-with-input" | "image-tail" }
  | { readonly kind: "undeliverable-result"; readonly result: UndeliverableResult }
  /** The request's input is only runtime notices, but the last result cannot carry them (`planRequest`). */
  | { readonly kind: "notice-carrier"; readonly reason: "error" | "rewrite" | UndeliverableResult }
  | { readonly kind: "identity"; readonly field: keyof QueryIdentity };

/** Why the handler path cannot take a result (`handlerPath`). */
type UndeliverableResult = "image" | "empty" | "over-limit" | "error-over-limit" | "error";

/** How the result that the model reads differs from the result in canonical history. The CLI rewrites a result that
 *  the handler path takes by a fixed rule (`handlerPath`): its own text for a blank success (`no-output`), and the
 *  joined, trimmed text of an error (`error-joined`). A shared agent host folds the runtime notices of the request's
 *  input into the batch's last result (`notice-folded`): one text block per notice follows the result's own blocks. */
export type ResultRewrite = "no-output" | "error-joined" | "notice-folded";

/** A tool result that the parked handler returns. */
export interface DeliverableResult {
  readonly toolUseId: string;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: true;
  /** How the CLI changes the result before the model reads it. Without it, the model reads the result unchanged. */
  readonly rewrite?: ResultRewrite;
}

export type RequestPlan =
  /** Push one user message into the idle query. */
  | { readonly kind: "push"; readonly message: CliMessage }
  /** Resolve the parked handlers with these results. */
  | { readonly kind: "deliver"; readonly results: readonly DeliverableResult[] }
  /** Stop any live query, start a new one from a transcript of `history` (none when it is empty), and push
   *  `message`. `reminders` are the history's reminders; the pushed message's reminders are left to the CLI. The
   *  tail is the pushed message (`push`), or the last transcript row with an empty push after it (`row`). */
  | { readonly kind: "start"; readonly trigger: StartTrigger; readonly history: readonly CliMessage[]; readonly reminders: readonly PlacedReminder[]; readonly message: CliMessage; readonly delivery: "push" | "row" }
  | { readonly kind: "refuse"; readonly issue: string };

/** Which results a parked query takes through its handlers. A shared agent host also takes the results that the CLI
 *  rewrites by a fixed rule, because a restart there costs a dispatcher request; the chat's query restarts in place. */
type HandlerResults = "successes" | "successes-and-errors";

/** What a parked query takes through its handlers: `results` names the results, and `runtimeNotices` holds the text of
 *  the request's trailing runtime notices (`trailingRuntimeNotices`), which the last result may carry. The chat's query
 *  takes no notice, so a notice there restarts it in place as any other input does. */
export interface HandlerDelivery {
  readonly results: HandlerResults;
  readonly runtimeNotices: readonly string[];
}

const CHAT_DELIVERY: HandlerDelivery = { results: "successes", runtimeNotices: [] };

/** A plan that starts the request's query, by a new process or by an in-place rotation of the live one. */
export type StartPlan = Extract<RequestPlan, { kind: "start" }>;

/**
 * Decides how one Flywheel request reaches the CLI (bridge rules 2, 5, and 11). A live query serves the request
 * only when its identity is equal and its copy is an exact prefix of the request, so any history difference,
 * including a redacted secret that the model wrote, starts a new query from canonical history. A parked query
 * takes results through its handlers only when the request adds exactly those results and each is safe there.
 * Every other request starts a new query and pushes the whole tail as one user message: the tool results first,
 * then the person's text and the notices, which is the native framing. The history before a pushed tail therefore
 * ends at an assistant message: the shared projection joins each run of user messages and drops an answer that has
 * no content. This matters because the CLI joins a transcript's last user row and a pushed message with a newline
 * that native never sends.
 *
 * The CLI rewrites a top-level image of a pushed message that is above its limits, but it sends a transcript row
 * unchanged. A tail with such an image is therefore the last transcript row, and the query takes an empty push
 * after it, which adds no message. Every other tail is pushed. `delivery` names the results that a parked query takes
 * through its handlers (`handlerPath`).
 *
 * A tail whose input is exactly the request's runtime notices (`delivery.runtimeNotices`, as a multiset of its text
 * blocks) and at least one result is a fold: the notices ride on the batch's last result, after its own text, so the
 * parked engine reads them in the open tool call and no dispatch answers them. An unlabeled block, also one with a
 * notice's text, makes the input more than notices. The carrier must be a success that reaches the model unchanged,
 * and the combined result must still pass the handler path, else the request starts the query (`notice-carrier`):
 * a notice never rides inside a failed tool's error.
 */
export function planRequest(view: CliView, state: QueryState, delivery: HandlerDelivery = CHAT_DELIVERY): RequestPlan {
  const message = view.messages.at(-1);
  if (message === undefined) return { kind: "refuse", issue: "the request holds no message" };
  if (message.role !== "user") return { kind: "refuse", issue: "the request ends with an assistant message" };
  const rowTail = message.content.some((block) => block.type === "image" && cliRewritesImage(block.source));
  const start = (trigger: StartTrigger): RequestPlan => {
    const history = rowTail ? view.messages : view.messages.slice(0, -1);
    const reminders = view.reminders.filter((placed) => placed.message < history.length);
    return { kind: "start", trigger, history, reminders, message: rowTail ? { role: "user", content: [] } : message, delivery: rowTail ? "row" : "push" };
  };
  if (state.kind !== "idle" && state.kind !== "parked") {
    return start({ kind: state.kind === "released" && view.messages.length === 1 ? "first-request" : state.kind });
  }
  const { copy } = state;
  const field = identityDifference(copy.identity, view.identity);
  if (field !== undefined) return start({ kind: "identity", field });
  if (copy.messages.length >= view.messages.length || !copy.messages.every((held, index) => sameCliValue(held, view.messages[index]))) {
    return start({ kind: "history" });
  }
  if (view.messages.length - copy.messages.length !== 1) return start({ kind: "tail" });
  if (rowTail) return start({ kind: "image-tail" });
  if (state.kind === "idle") return { kind: "push", message };
  const results = message.content.filter((block) => block.type === "tool_result");
  const input = message.content.filter((block) => block.type !== "tool_result");
  const notices = input.flatMap((block) => block.type === "text" ? [block] : []);
  if (input.length > 0 && (results.length === 0 || notices.length < input.length || !sameTexts(notices.map((block) => block.text), delivery.runtimeNotices))) {
    return start({ kind: "results-with-input" });
  }
  if (!sameCliValue(results.map((result) => result.tool_use_id), state.toolUseIds)) return start({ kind: "result-ids" });
  const delivered: DeliverableResult[] = [];
  for (const result of results) {
    const path = handlerPath(result, delivery.results);
    if ("undeliverable" in path) return start({ kind: "undeliverable-result", result: path.undeliverable });
    delivered.push({
      toolUseId: result.tool_use_id, content: result.content.flatMap((block) => block.type === "text" ? [block] : []),
      ...(result.is_error === true ? { isError: true } : {}), ...(path.rewrite === undefined ? {} : { rewrite: path.rewrite }),
    });
  }
  const carrier = delivered.at(-1);
  if (notices.length === 0 || carrier === undefined) return { kind: "deliver", results: delivered };
  if (carrier.isError === true) return start({ kind: "notice-carrier", reason: "error" });
  if (carrier.rewrite !== undefined) return start({ kind: "notice-carrier", reason: "rewrite" });
  const folded = { ...carrier, content: [...carrier.content, ...notices], rewrite: "notice-folded" as const };
  const path = handlerPath({ type: "tool_result", tool_use_id: folded.toolUseId, content: folded.content }, delivery.results);
  if ("undeliverable" in path) return start({ kind: "notice-carrier", reason: path.undeliverable });
  return { kind: "deliver", results: [...delivered.slice(0, -1), folded] };
}

/** Whether `a` and `b` hold the same texts, each as often, in any order. */
function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (texts: readonly string[]) => [...texts].sort();
  return sameCliValue(sorted(a), sorted(b));
}

/**
 * Bridge rule 2: how the handler path sends a result, or why it cannot. The CLI (2.1.306, verified on a fake host)
 * sends a success result whose text is blank, or that has no content, as `(<tool> completed with no output)`, with
 * the tool's MCP name. It sends an error result as one text: its blocks joined by newlines and trimmed, with the middle
 * cut out of a text over 10,000 characters. It drops images. The chat's query restarts in place, so `handler`
 * "successes" takes only a result that the CLI keeps intact: non-blank text within the server's size limit, and no
 * error. A shared agent host also takes a result whose rewrite is fixed, which its transport record states
 * (`rewrite`): a blank success and an error within the limit. A result that the CLI cuts or drops, and a result that
 * is only partly blank, goes by a rotation push instead.
 */
function handlerPath(result: Extract<CliBlock, { type: "tool_result" }>, handler: HandlerResults): { readonly undeliverable: UndeliverableResult } | { readonly rewrite?: ResultRewrite } {
  const texts = result.content.flatMap((block) => block.type === "text" ? [block.text] : []);
  if (texts.length < result.content.length) return { undeliverable: "image" };
  const blank = (text: string) => text.trim() === "";
  if (result.is_error !== true && handler === "successes-and-errors" && texts.every(blank)) return { rewrite: "no-output" };
  if (texts.length === 0 || texts.some(blank)) return { undeliverable: "empty" };
  if (result.is_error !== true) return texts.reduce((total, text) => total + text.length, 0) <= HANDLER_RESULT_LIMIT ? {} : { undeliverable: "over-limit" };
  if (handler === "successes") return { undeliverable: "error" };
  const joined = texts.join("\n");
  if (joined.length > HANDLER_ERROR_LIMIT) return { undeliverable: "error-over-limit" };
  return texts.length === 1 && joined === joined.trim() ? {} : { rewrite: "error-joined" };
}
