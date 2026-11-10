/**
 * The narrowing statement (ARCH-CONTEXT-034). A tree-hosted agent shares its chat tree's tools, stable prompt, roster,
 * and catalog, which its tree's capture of modules and agent types decides, while its own module selection and
 * configuration decide what it may call and dispatch. When that selection turns off a module whose tools the shared
 * text describes, or its configuration turns off an agent type that the shared roster offers, the agent's next request
 * carries one recorded system-origin statement that names every module and agent type turned off for it now, and a
 * later change of that set, a module or type turned on again included, carries one more. The conversation history
 * alone decides whether a statement is due: the latest statement, or the tool notice that carried one, names what was
 * already told. So a resumed or compacted conversation decides from what it holds, a fork copies no statement, and
 * recorded turns never change.
 */

import { DebugLog } from "../../infra/debug-log.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import type { HistorySink } from "./agent-loop-types.js";
import type { ConversationMessage } from "./llm/types.js";

// The marker, not the wording, identifies a statement in history, so a later release reads it however the body
// changes. Only an entry with tool-notice framing carries one: a statement stands alone, and the tool notice carries
// one after its own text. A marker that any other entry quotes, such as a task, is never a statement. A statement
// that names no agent type has no `types` attribute, so a statement about modules alone keeps its earlier bytes. A
// type is any string that a person lists, so each one is percent-encoded in the attribute and a comma or quote in it
// cannot change what the marker names; an ordinary role id encodes to itself.
const MARKER = /<system-reminder mode="capabilities" state="narrowed" modules="([^"\n]*)"(?: types="([^"\n]*)")?>/;

/** What is turned off for one agent now: modules by id, and agent types as `[subagents] disabled_types` names them. */
export interface TurnedOff {
  readonly moduleIds: readonly string[];
  readonly types: readonly string[];
}

/** A due narrowing: everything turned off for the agent now, and the statement that says so. */
export interface CapabilityNarrowing extends TurnedOff {
  readonly statement: string;
}

const ids = (list: string | undefined): readonly string[] => list?.split(",").filter((id) => id !== "") ?? [];

/** What a narrowing statement in `message` names, or undefined when it carries none. */
function narrowedIn(message: ConversationMessage): TurnedOff | undefined {
  if (message.kind !== "user" || message.origin !== "system" || message.framing !== "tool-notice" || typeof message.content !== "string") return undefined;
  const marker = MARKER.exec(message.content);
  return marker === null ? undefined : { moduleIds: ids(marker[1]), types: ids(marker[2]).map(decodeURIComponent) };
}

/** The name a person sees for `moduleId` in Settings. */
function displayName(composition: FirstPartyModuleComposition, moduleId: string): string {
  for (const contribution of composition.installedContributions) {
    if (contribution.module !== moduleId || contribution.domain !== "settings") continue;
    const control = contribution.value;
    if (control.control === "binary" || control.control === "workflow-mode") return control.label;
  }
  return moduleId;
}

function statementOf(composition: FirstPartyModuleComposition, off: TurnedOff, told: TurnedOff): string {
  const names = (moduleIds: readonly string[]) => moduleIds.map((id) => displayName(composition, id)).join(", ");
  const restored = told.moduleIds.filter((id) => !off.moduleIds.includes(id));
  const restoredTypes = told.types.filter((type) => !off.types.includes(type));
  const lines = [
    ...(off.moduleIds.length > 0 ? [`Turned off for you while this chat tree runs: ${names(off.moduleIds)}. Text about them in your tools, instructions, and earlier turns no longer applies, and their calls are refused.`] : []),
    ...(restored.length > 0 ? [`On again for you: ${names(restored)}. Text about them applies again, and their calls run.`] : []),
    ...(off.types.length > 0 ? [`Agent types turned off for you while this chat tree runs: ${off.types.join(", ")}. Text about them in your tools, instructions, and earlier turns no longer applies, and their dispatch is refused.`] : []),
    ...(restoredTypes.length > 0 ? [`Agent types on again for you: ${restoredTypes.join(", ")}. Text about them applies again, and their dispatch runs.`] : []),
  ];
  const types = off.types.length > 0 ? ` types="${off.types.map(encodeURIComponent).join(",")}"` : "";
  return `<system-reminder mode="capabilities" state="narrowed" modules="${off.moduleIds.join(",")}"${types}>\n${lines.join("\n")}\n</system-reminder>`;
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));

/**
 * The narrowing of one agent's run. `due` answers before each request: undefined when the modules that the request's
 * plan turned off (`ToolExposurePlan.turnedOff`) and the agent types its configuration turned off
 * (`agentTypesTurnedOffSince`) are the sets that the latest statement in its history named, else the statement that
 * names the new sets, which are empty when everything is on again. It reads only the
 * messages added since its last answer, and the whole history again only when the history became shorter, as after a
 * compaction, so the history alone decides what the agent was told.
 */
export function createCapabilityNarrowing(composition: () => FirstPartyModuleComposition) {
  const none: TurnedOff = { moduleIds: [], types: [] };
  let scanned = 0;
  let told = none;
  return {
    due(messages: readonly ConversationMessage[], off: TurnedOff): CapabilityNarrowing | undefined {
      if (messages.length < scanned) {
        scanned = 0;
        told = none;
      }
      for (const message of messages.slice(scanned)) told = narrowedIn(message) ?? told;
      scanned = messages.length;
      if (sameIds(off.moduleIds, told.moduleIds) && sameIds(off.types, told.types)) return undefined;
      return { ...off, statement: statementOf(composition(), off, told) };
    },
  };
}

/** The statement of a due narrowing to append before a request, as a hidden system-origin user message with
 *  tool-notice framing, which a fork does not copy, or none when no narrowing is due. */
export function narrowingStatements(narrowing: CapabilityNarrowing | undefined): readonly ConversationMessage[] {
  return narrowing === undefined ? [] : [{ kind: "user", origin: "system", framing: "tool-notice", content: narrowing.statement }];
}

/** The one diagnostic record of a narrowing that an agent's history now holds: ids and a count, no content. */
export function recordNarrowing(sessionId: string | undefined, { moduleIds, types }: TurnedOff, via: "tool-notice" | "statement"): void {
  DebugLog.record({
    type: "agent.capabilities.narrowed",
    ...(sessionId === undefined ? {} : { sessionId }),
    payload: { via, moduleIds, types, count: moduleIds.length + types.length },
  });
}

/** `history`, which records each narrowing statement once its append resolves, so a rejected append records
 *  nothing and its retry records once. Every other message passes through unchanged. */
export function recordingNarrowings(history: HistorySink, sessionId: string | undefined): HistorySink {
  return {
    ...history,
    append(message, entryId) {
      const off = narrowedIn(message);
      if (off === undefined) return history.append(message, entryId);
      return Promise.resolve(history.append(message, entryId)).then(() => recordNarrowing(sessionId, off, "statement"));
    },
  };
}
