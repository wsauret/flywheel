/**
 * The narrowing statement (ARCH-CONTEXT-034). A tree-hosted agent shares its chat tree's tools, stable prompt, roster,
 * and catalog, which its tree's module capture decides, while its own module selection decides what it may call. When
 * that selection turns off a module whose tools the shared text describes, the agent's next request carries one
 * recorded system-origin statement that names every module that its calls are refused for now, and a later change of
 * that set, a module turned on again included, carries one more. The conversation history alone decides whether a
 * statement is due: the latest statement, or the tool notice that carried one, names the modules already told. So a
 * resumed or compacted conversation decides from what it holds, a fork copies no statement, and recorded turns never
 * change.
 */

import { DebugLog } from "../../infra/debug-log.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import type { HistorySink } from "./agent-loop-types.js";
import type { ConversationMessage } from "./llm/types.js";

// The marker, not the wording, identifies a statement in history, so a later release reads it however the body
// changes. Only an entry with tool-notice framing carries one: a statement stands alone, and the tool notice carries
// one after its own text. A marker that any other entry quotes, such as a task, is never a statement.
const MARKER = /<system-reminder mode="capabilities" state="narrowed" modules="([^"\n]*)">/;

/** A due narrowing: every module turned off for the agent now, and the statement that says so. */
export interface CapabilityNarrowing {
  readonly moduleIds: readonly string[];
  readonly statement: string;
}

/** The modules that a narrowing statement in `message` names, or undefined when it carries none. */
function narrowedIn(message: ConversationMessage): readonly string[] | undefined {
  if (message.kind !== "user" || message.origin !== "system" || message.framing !== "tool-notice" || typeof message.content !== "string") return undefined;
  return MARKER.exec(message.content)?.[1]?.split(",").filter((id) => id !== "");
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

function statementOf(composition: FirstPartyModuleComposition, moduleIds: readonly string[], told: ReadonlySet<string>): string {
  const names = (ids: readonly string[]) => ids.map((id) => displayName(composition, id)).join(", ");
  const restored = [...told].filter((id) => !moduleIds.includes(id));
  const lines = [
    ...(moduleIds.length > 0 ? [`Turned off for you while this chat tree runs: ${names(moduleIds)}. Text about them in your tools, instructions, and earlier turns no longer applies, and their calls are refused.`] : []),
    ...(restored.length > 0 ? [`On again for you: ${names(restored)}. Text about them applies again, and their calls run.`] : []),
  ];
  return `<system-reminder mode="capabilities" state="narrowed" modules="${moduleIds.join(",")}">\n${lines.join("\n")}\n</system-reminder>`;
}

/**
 * The narrowing of one agent's run. `due` answers before each request: undefined when the modules that the request's
 * plan turned off (`turnedOff`, `ToolExposurePlan.turnedOff`) are the set that the latest statement in its history
 * named, else the statement that names the new set, which is empty when every module is on again. It reads only the
 * messages added since its last answer, and the whole history again only when the history became shorter, as after a
 * compaction, so the history alone decides what the agent was told.
 */
export function createCapabilityNarrowing(composition: () => FirstPartyModuleComposition) {
  let scanned = 0;
  let told: ReadonlySet<string> = new Set();
  return {
    due(messages: readonly ConversationMessage[], turnedOff: readonly string[]): CapabilityNarrowing | undefined {
      if (messages.length < scanned) {
        scanned = 0;
        told = new Set();
      }
      for (const message of messages.slice(scanned)) {
        const named = narrowedIn(message);
        if (named !== undefined) told = new Set(named);
      }
      scanned = messages.length;
      if (turnedOff.length === told.size && turnedOff.every((id) => told.has(id))) return undefined;
      return { moduleIds: turnedOff, statement: statementOf(composition(), turnedOff, told) };
    },
  };
}

/** The statement of a due narrowing to append before a request, as a hidden system-origin user message with
 *  tool-notice framing, which a fork does not copy, or none when no narrowing is due. */
export function narrowingStatements(narrowing: CapabilityNarrowing | undefined): readonly ConversationMessage[] {
  return narrowing === undefined ? [] : [{ kind: "user", origin: "system", framing: "tool-notice", content: narrowing.statement }];
}

/** The one diagnostic record of a narrowing that an agent's history now holds: ids and a count, no content. */
export function recordNarrowing(sessionId: string | undefined, moduleIds: readonly string[], via: "tool-notice" | "statement"): void {
  DebugLog.record({
    type: "agent.capabilities.narrowed",
    ...(sessionId === undefined ? {} : { sessionId }),
    payload: { via, moduleIds, count: moduleIds.length },
  });
}

/** `history`, which records each narrowing statement once its append resolves, so a rejected append records
 *  nothing and its retry records once. Every other message passes through unchanged. */
export function recordingNarrowings(history: HistorySink, sessionId: string | undefined): HistorySink {
  return {
    ...history,
    append(message, entryId) {
      const moduleIds = narrowedIn(message);
      if (moduleIds === undefined) return history.append(message, entryId);
      return Promise.resolve(history.append(message, entryId)).then(() => recordNarrowing(sessionId, moduleIds, "statement"));
    },
  };
}
