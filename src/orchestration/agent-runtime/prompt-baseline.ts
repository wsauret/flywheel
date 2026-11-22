/**
 * The system prompt of a conversation, fixed for each context (ARCH-CONTEXT-044). The prompt renders when a context
 * opens, and inside the context again only for another code, model, or tool surface (its identity). Every other
 * change of a part keeps the prompt's bytes: a hidden system-origin entry states it once, where it first applies
 * (ARCH-CONTEXT-042), and the next context renders it into its own prompt. A render inside a context keeps the
 * context's `hold` parts, such as the environment with the date on which the context opened (PI-MODEL-093).
 */

import { Log } from "../../infra/log.js";
import { redactSecrets } from "../../infra/redact-secrets.js";
import { promptContextOpening, type ConversationPromptBaseline } from "../session/conversation-prompt-baseline.js";
import { turnContextEntry } from "./agent-loop-turn-context.js";
import type { SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import type { ConversationMessage } from "./llm/types.js";
import { joinSystemPromptParts, type SystemPromptPart } from "./system-prompt.js";

const log = Log.create({ service: "prompt-baseline" });

/** Where a conversation's fixed prompt is kept: a durable conversation's fact, which a pre-start reads and never
 *  writes. */
export interface PromptBaselineStore {
  read(): Promise<ConversationPromptBaseline | undefined>;
  readonly record?: (baseline: ConversationPromptBaseline) => Promise<void>;
}

// ── Update entries ───────────────────────────────────────────────

const MARKER = /^<system-reminder prompt-part="([^"\n]+)">\n/;
const END = "\n</system-reminder>";

const replacedHeading = (label: string): string => `This replaces the "${label}" part of your system prompt.\n\n`;
const removedBody = (label: string): string => `The "${label}" part of your system prompt no longer applies.`;
const restoredBody = (label: string): string => `The "${label}" part of your system prompt is current again. Earlier updates to it no longer apply.`;
const catalogHeading = (label: string): string => `These entries of the "${label}" part of your system prompt changed. A "+" line is a new entry, a "~" line replaces the entry with its id, and a "-" line names an entry that was removed.`;

/** What the history of a context states over its prompt for one part, redacted as the history holds it: the text
 *  that replaces a `replace` part (undefined when it was removed), or the lines that a `catalog` part's entries set
 *  (undefined when an entry removed the line), by id. */
type Stated =
  | { readonly change: "replace"; readonly text: string | undefined }
  | { readonly change: "catalog"; readonly lines: ReadonlyMap<string, string | undefined> };

const catalogId = (line: string): string | undefined => /^([^:\n]+): /.exec(line)?.[1];

/** The `id: text` lines of a catalog part by id. The first line is the catalog's heading. */
function catalogLines(text: string | undefined): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of text?.split("\n").slice(1) ?? []) {
    const id = line.startsWith("- ") ? catalogId(line.slice(2)) : undefined;
    if (id !== undefined) lines.set(id, line.slice(2));
  }
  return lines;
}

/** Advances `stated` by one entry of the history. Every entry that `updates` returns passes through here as well, so
 *  a resumed history and a live one reach the same state. */
function applyEntry(stated: Map<string, Stated>, content: string): void {
  const label = MARKER.exec(content)?.[1];
  if (label === undefined || !content.endsWith(END)) return;
  const body = content.slice(content.indexOf("\n") + 1, -END.length);
  if (body === restoredBody(label)) stated.delete(label);
  else if (body === removedBody(label)) stated.set(label, { change: "replace", text: undefined });
  else if (body.startsWith(replacedHeading(label))) stated.set(label, { change: "replace", text: body.slice(replacedHeading(label).length) });
  else if (body.startsWith(`${catalogHeading(label)}\n`)) {
    const prior = stated.get(label);
    const lines = new Map(prior?.change === "catalog" ? prior.lines : []);
    for (const line of body.split("\n").slice(1)) {
      const entry = line.slice(2);
      if (line.startsWith("- ")) lines.set(entry, undefined);
      else {
        const id = catalogId(entry);
        if (id !== undefined) lines.set(id, entry);
      }
    }
    stated.set(label, { change: "catalog", lines });
  }
}

function statedIn(messages: readonly ConversationMessage[]): Map<string, Stated> {
  const stated = new Map<string, Stated>();
  for (const message of messages) {
    if (message.kind === "user" && message.framing === "turn-context" && typeof message.content === "string") applyEntry(stated, message.content);
  }
  return stated;
}

/** The body of the entry that brings a `replace` part from what the model holds (the prompt's `fixed`, or what the
 *  history `stated`) to its `current` text, or undefined when the model holds it. */
function replaceUpdate(label: string, fixed: string | undefined, current: string | undefined, stated: Stated | undefined): string | undefined {
  if (stated === undefined && current === fixed) return undefined;
  const held = stated?.change === "replace" ? stated.text : fixed === undefined ? undefined : redactSecrets(fixed);
  if (held === (current === undefined ? undefined : redactSecrets(current))) return undefined;
  if (current === undefined) return removedBody(label);
  if (current === fixed) return restoredBody(label);
  return `${replacedHeading(label)}${current}`;
}

/** The body of the entry that brings a `catalog` part from the lines that the model holds to its `current` lines, or
 *  undefined when the model holds them. */
function catalogUpdate(label: string, fixed: string | undefined, current: string | undefined, stated: Stated | undefined): string | undefined {
  if (stated === undefined && current === fixed) return undefined;
  const held = catalogLines(fixed === undefined ? undefined : redactSecrets(fixed));
  if (stated?.change === "catalog") {
    for (const [id, line] of stated.lines) {
      if (line === undefined) held.delete(id);
      else held.set(id, line);
    }
  }
  const next = catalogLines(current === undefined ? undefined : redactSecrets(current));
  const lines = [
    ...[...next].flatMap(([id, line]) => held.get(id) === undefined ? [`+ ${line}`] : held.get(id) === line ? [] : [`~ ${line}`]),
    ...[...held.keys()].flatMap((id) => next.has(id) ? [] : [`- ${id}`]),
  ];
  return lines.length === 0 ? undefined : [catalogHeading(label), ...lines].join("\n");
}

// ── The fixed prompt ─────────────────────────────────────────────

/** The prompt of one context of the run's conversation. */
interface Context {
  readonly baseline: ConversationPromptBaseline;
  readonly tiers: SystemPromptTiers;
  /** What the history of the context states over the prompt, part by part. Read from the history once for each
   *  context, then advanced by each entry that `updates` returns. A render inside the context keeps it, because the
   *  history keeps its entries. */
  stated?: Map<string, Stated>;
}

/** The fixed prompt of one run's conversation, with the entries that state what changed since it was written. */
export interface PromptBaseline {
  /**
   * The tiers that the request sends: the context's fixed prompt, or `parts` rendered when the context of `messages`
   * has none, or `identity` names another code, model, or tool surface than the one that it rendered for. A render
   * inside a context keeps the context's `hold` parts. A new prompt is recorded in `store` before it is returned.
   */
  prompt(parts: readonly SystemPromptPart[], identity: string, messages: readonly ConversationMessage[]): Promise<SystemPromptTiers>;
  /** The entries that bring the history of `messages` up to the parts of the latest `prompt` call: one for each part
   *  whose current text the model does not hold yet. Each is returned once. */
  updates(messages: readonly ConversationMessage[]): readonly ConversationMessage[];
  /** A compaction replaced the history with a fresh context, which the next `prompt` call renders for. */
  reset(): void;
}

export function createPromptBaseline(store: PromptBaselineStore | undefined, conversation: { readonly sessionId?: string | undefined; readonly conversationId?: string | undefined }): PromptBaseline {
  let restored: Promise<void> | undefined;
  let context: Context | undefined;
  let rendered = false;
  let resetDue = false;
  let current: readonly SystemPromptPart[] | undefined;
  // A recorded prompt applies to this run only while the history holds the context that it is fixed for.
  const restore = async (messages: readonly ConversationMessage[]): Promise<void> => {
    const recorded = await store?.read();
    rendered = recorded !== undefined;
    if (recorded?.opening === promptContextOpening(messages)) context = { baseline: recorded, tiers: joinSystemPromptParts(recorded.parts) };
  };
  return {
    async prompt(parts, identity, messages) {
      current = parts;
      await (restored ??= restore(messages));
      if (resetDue) {
        resetDue = false;
        context = undefined;
      }
      if (context?.baseline.identity === identity) return context.tiers;
      const reason = context !== undefined ? "identity" : rendered ? "context" : "opened";
      const held = new Map(context?.baseline.parts.flatMap((part) => part.change === "hold" ? [[part.label, part.text]] : []));
      const baseline: ConversationPromptBaseline = {
        opening: context?.baseline.opening ?? promptContextOpening(messages),
        identity,
        parts: parts.map(({ label, tier, change, text }) => ({ label, tier, change, text: held.get(label) ?? text })),
      };
      const recorded = store?.record !== undefined;
      await store?.record?.(baseline);
      context = { baseline, tiers: joinSystemPromptParts(baseline.parts), ...context?.stated ? { stated: context.stated } : {} };
      rendered = true;
      // Only a recorded prompt is a state change. A pre-start renders for every runner start and records nothing.
      log[recorded ? "info" : "debug"]("system prompt rendered", { ...conversation, reason, parts: parts.length, bytes: baseline.parts.reduce((total, part) => total + part.text.length, 0) });
      return context.tiers;
    },
    updates(messages) {
      if (context === undefined || current === undefined) return [];
      context.stated ??= statedIn(messages);
      const { stated } = context;
      const fixed = new Map(context.baseline.parts.map((part) => [part.label, part]));
      const now = new Map(current.map((part) => [part.label, part]));
      const entries: ConversationMessage[] = [];
      for (const label of new Set([...fixed.keys(), ...now.keys(), ...stated.keys()])) {
        const change = now.get(label)?.change ?? fixed.get(label)?.change ?? stated.get(label)?.change;
        const update = change === "replace" ? replaceUpdate : change === "catalog" ? catalogUpdate : undefined;
        const body = update?.(label, fixed.get(label)?.text, now.get(label)?.text, stated.get(label));
        if (body === undefined) continue;
        const text = `<system-reminder prompt-part="${label}">\n${body}${END}`;
        applyEntry(stated, redactSecrets(text));
        entries.push(turnContextEntry(text));
        log.info("system prompt update appended", { ...conversation, part: label, bytes: text.length });
      }
      return entries;
    },
    reset() {
      resetDue = true;
    },
  };
}
