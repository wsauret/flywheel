import { parseProjectionFact } from "../../infra/event-projection.js";
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js";
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js";
import type { CommandEvidence, ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";
import { tryOpenConversationTree } from "../session/conversation/conversation-tree-handle.js";
import { parseSessionRuntimeFact } from "../session/session-runtime-event-types.js";
import { parseBashResultDetails } from "../agent-runtime/tools/bash.js";
import { workflowRunReader } from "../module-catalog.js";
import { parseFileMutationFact } from "../session/file-mutation-facts.js";
import { recordedExecutionCwd } from "../session/session-execution-directory.js";
import { shellCommandOf } from "../tool-catalog.js";
import { loadToolExecutionTimelineFromEvents, TOOL_EXECUTION_FACT_TYPES } from "../session/tool-execution-projection.js";
import { workflowMembershipReader } from "../session/workflow-membership.js";

interface CommandEvidenceSourceDeps {
  readonly workflowId: string;
  /** What a workflow with no recorded directory resolves against. */
  readonly projectRoot: string;
  readonly projectionReader: AsyncEventStateReadSurface;
  readonly awaitDurableFacts: () => Promise<void>;
}

export interface CommandEvidenceSource {
  forConversation(conversationId: string): ReadCommandEvidence;
}

async function completedToolUseIds(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  conversationId: string,
): Promise<Set<string>> {
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: reader });
  if (!tree) return new Set();
  try {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const entry of await tree.getBranch()) {
      if (entry.kind !== "message") continue;
      if (entry.message.kind === "assistant" && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_use") calls.add(block.id);
        }
      } else if (entry.message.kind === "toolResult") {
        results.add(entry.message.toolUseId);
      }
    }
    return new Set([...calls].filter((id) => results.has(id)));
  } finally {
    tree.getStorage().dispose();
  }
}


interface RecordedResult {
  readonly details: unknown;
  readonly position: number;
}

function resultsByToolUseId(
  events: readonly StoredFact[],
): ReadonlyMap<string, RecordedResult> {
  const results = new Map<string, RecordedResult>();
  for (const event of events) {
    if (event.type !== "tool.result.recorded") continue;
    const fact = parseProjectionFact(event, parseSessionRuntimeFact);
    if (fact.type === "tool.result.recorded") results.set(fact.payload.toolUseId, { details: fact.payload.details, position: event.position });
  }
  return results;
}

/** Each file change that the member session recorded after `afterPosition`,
 *  whatever its origin, in position order. */
async function fileChangesAfter(reader: AsyncEventStateReadSurface, sessionId: string, afterPosition: number): Promise<readonly { readonly position: number; readonly displayPath: string }[]> {
  const slice = await reader.readSlice({ aggregateId: `session:${sessionId}`, types: ["file.changed"], afterPosition });
  return slice.facts.map((fact) => {
    // A change that cannot be read could be one after the cited run, so the
    // ledger read fails rather than claim that nothing changed.
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
    if (fact instanceof CorruptEventRowError) throw fact;
    const change = parseProjectionFact(fact, parseFileMutationFact);
    if (change.type !== "file.changed") throw new Error(`Expected file.changed at position ${fact.position}, found ${change.type}`);
    return { position: fact.position, displayPath: change.payload.displayPath };
  });
}

/** Reads command evidence from the existing durable tool ledger, scoped to one
 * worker conversation so a handoff cannot borrow another attempt's result.
 * Each shell call carries the command and directory of its registration's
 * shell facet, judged against the workflow's recorded directory, and the files
 * that changed in the member session after its result was recorded. */
export function createCommandEvidenceSource(deps: CommandEvidenceSourceDeps): CommandEvidenceSource {
  return {
    forConversation: (conversationId) => async (): Promise<readonly CommandEvidence[]> => {
      await deps.awaitDurableFacts();
      const member = (await workflowMembershipReader(deps.projectionReader).list(deps.workflowId)).find((candidate) => candidate.conversationId === conversationId);
      if (!member) throw new Error(`Workflow conversation ${conversationId} has no member session`);
      const completed = await completedToolUseIds(deps.projectionReader, member.sessionId, conversationId);
      const slice = await deps.projectionReader.readSlice({
        aggregateId: `session:${member.sessionId}`,
        types: TOOL_EXECUTION_FACT_TYPES,
        toolUseIds: [...completed],
      });
      const events = slice.facts.map((fact) => {
        // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
        if (fact instanceof CorruptEventRowError) throw fact;
        return hydrateToolContentFact(fact, slice.toolContent);
      });
      const results = resultsByToolUseId(events);
      const executionCwd = recordedExecutionCwd(await workflowRunReader(deps.projectionReader).read(deps.workflowId), deps.projectRoot);
      const runs = loadToolExecutionTimelineFromEvents(events).map((entry) => {
        const shell = shellCommandOf(entry.toolName, entry.input ?? {}, executionCwd);
        const result = results.get(entry.toolUseId);
        // Every registration of the shell records the Bash result details, so
        // a completed foreground call of any of them is command evidence.
        const exitCode = shell ? parseBashResultDetails(result?.details ?? {}).exitCode : undefined;
        return { entry, shell, exitCode, resultPosition: exitCode === undefined ? undefined : result?.position };
      });
      const resultPositions = runs.flatMap(({ resultPosition }) => resultPosition === undefined ? [] : [resultPosition]);
      const changes = resultPositions.length === 0 ? [] : await fileChangesAfter(deps.projectionReader, member.sessionId, Math.min(...resultPositions));
      return runs.map(({ entry, shell, exitCode, resultPosition }) => ({
        toolUseId: entry.toolUseId,
        command: shell?.command,
        cwd: shell?.cwd,
        exitCode,
        changedAfter: resultPosition === undefined ? [] : [...new Set(changes.flatMap((change) => change.position > resultPosition ? [change.displayPath] : []))],
        executionMode: entry.executionMode,
      }));
    },
  };
}
