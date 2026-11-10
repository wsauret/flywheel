/** The `memory` write tool. One
 *  tool, two bounded stores keyed by learning reach (project notes and global
 *  user memory), three actions plus an atomic batch. Behavioral guidance lives
 *  in the schema description; the snapshot the stores inject into the prompt
 *  is captured by prompt assembly at each person message, not by this tool,
 *  so tool responses always reflect live state. */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { memoryWrittenFact } from "../../../../workflows/memory/memory-fact-writers.js";
import type { MemoryWrittenFact } from "../../../../workflows/memory/memory-facts.js";
import type { AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js";
import type { CapabilityCheck } from "../../../../infra/capability-text.js";
import { Log } from "../../../../infra/log.js";
import { normalizeMemoryTitle } from "../../../../infra/tools/memory-title.js";
import type { LearningScope } from "../../../../infra/learning-scope.js";
import type { MutationEvidence } from "../../../../infra/mutation-evidence.js";
import { buildMutationDiffEvidence } from "../../../../infra/mutation-diff-evidence.js";
import { openPendingAudit, reconcilePendingAudits, settlePendingAudit, type PendingAudit } from "../learning-journal.js";
import { requireContainedDirectory } from "../../../../infra/write-file-under.js";
import type { SessionFactWriter } from "../../../session/session-fact-writer.js";
import {
  applyMemoryBatch,
  applyMemoryOperation,
  createMemoryStoreConfig,
  MAX_MEMORY_BATCH_OPERATIONS,
  memoryStorePath,
  readMemoryInventory,
  type MemoryMutationResult,
  type MemoryOperation,
  type MemoryPublication,
  type MemoryStoreConfig,
} from "../memory-store.js";
import type { RuntimeTool, RuntimeToolInput, ToolResult } from "../../../agent-runtime/tools/types.js";

/** After this many consecutive failed consolidation attempts (overflow or
 *  zero-match) in one turn, stop instructing the model to retry and return a
 *  terminal result: a fragile memory write must never loop the turn to budget
 *  exhaustion and suppress the user's reply. */
const MAX_CONSOLIDATION_FAILURES_PER_TURN = 3;

const log = Log.create({ service: "memory-tool" });

/** The memory description for a tree whose check is `has`: a repeatable procedure is sent to a skill only while the
 *  tree can write one. */
function description(has: CapabilityCheck): string {
  const skills = has("skill_manage");
  return `Maintain a small, selective profile of the user and their working context across many future sessions. Memory is scarce and enters future prompts: save only durable facts likely to change a future agent's decisions, not a record of this session.

HOW: make ALL your changes in ONE call via an 'operations' array (each item: {action, content?, old_text?}). The batch applies atomically and the char limit is checked only on the FINAL result - so a single call can remove or replace stale entries to free room AND add new ones, even when an add alone would overflow. The response reports current/limit chars and confirms completion; one batch call finishes the update, so do not repeat it. Use the bare action/content/old_text fields only for a single lone change.

BEFORE CALLING: read the selected reach's current/limit chars and entries from the memory snapshot or latest tool response. Calculate final usage = current usage - removed/replaced entry lengths + replacement/new entry lengths. Count the whole matched entry, not just old_text. Only entry content counts: JavaScript string.length (UTF-16 code units) after trimming, excluding JSON syntax, separators, and [protected] labels. When close to the limit, use an exact string-length calculation rather than a mental estimate. If the final usage exceeds the limit, trim in this same batch before submitting. Never submit an oversized update to discover how much space to free.

TITLE: Set title to a short, one-line phrase of at most 60 characters that tells the user what this call changes. Summarize the full batch, not only the first operation.

REACH: 'project' = durable user preferences and working context specific to this project. 'global' = the user's preferences and stable facts about them, which follow them into every project. A preference or fact that mentions this project, its repositories, or its tools is project reach, never global: global entries must make sense in a project that has never heard of this one. Use the narrowest reach that is correct; when applicability is unclear, use project.

WHEN: consider explicit preferences, corrections that reveal lasting preferences, stable user context, and hard-won repository or tool facts that are not instructions or cheaply rediscovered. Ask whether the fact will help across many future sessions, is supported by evidence, and is absent from an existing authority. Prioritize facts that prevent the user having to explain themselves again. A mistake or verified fix alone is not a reason to save memory. Saving nothing is often correct.

DESTINATIONS: Session notes hold progress, plans, handoffs, temporary findings, and completed-work summaries; never put these in memory. Shared repository instructions, commands, conventions, and architectural guidance belong in AGENTS.md or their existing repository authority. Maintain that authority rather than duplicating it in memory.${skills ? " Repeatable procedures belong in skills." : ""}

MAKING ROOM: free room in this order: delete stale entries first, then rotate out whole lower-priority entries. Compress an entry only while it stays a plain sentence a human can understand without this session's context; past that point intent is lost, so drop a whole entry instead of compressing many into fragments. If a call is still rejected, use the returned current entries and usage to recalculate one corrected batch.

PROTECTED: entries labeled [protected] are user-owned and permanent until the user sets their "protected" field to false in the memory file. Never replace or remove them, and never use any other tool to alter their content or protection flag.

SKIP: trivial or obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state.${skills ? " A repeatable procedure belongs in a skill, not memory." : ""}`;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "replace", "remove"],
      description: "The action to perform (single-op shape). Omit when using 'operations'.",
    },
    title: {
      type: "string",
      description: "Short one-line title for the transcript that summarizes the full mutation call.",
    },
    target: {
      type: "string",
      enum: ["project", "global"],
      description: "Reach of this memory: 'project' for durable user preferences and working context specific to this project, 'global' for the user's preferences and stable facts across projects. Anything that references this project stays project. Optional; defaults to project.",
    },
    content: {
      type: "string",
      description: "The entry content. Required for 'add' and 'replace' (single-op shape).",
    },
    old_text: {
      type: "string",
      description: "REQUIRED for 'replace' and 'remove' (single-op shape): a short unique substring identifying the existing entry to modify. Omit only for 'add'.",
    },
    operations: {
      type: "array",
      description: `Batch shape: at most ${MAX_MEMORY_BATCH_OPERATIONS} operations applied atomically in one call against the final char budget. Preferred when making multiple changes or consolidating to make room. Each item is {action, content?, old_text?}.`,
      maxItems: MAX_MEMORY_BATCH_OPERATIONS,
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "remove"] },
          content: { type: "string", description: "Entry content for add/replace." },
          old_text: { type: "string", description: "Substring identifying the entry for replace/remove." },
        },
        required: ["action"],
      },
    },
  },
  required: ["title"],
} as const;

export interface MemoryToolDeps {
  /** Canonical session this runner serves, for the fact's origin. The
   *  ToolContext sessionId is the conversation id, not this. Without it and
   *  without an `origin`, no write is attributable, so every write is refused. */
  sessionId?: string;
  /** Fact origin override; the review fork writes under its reviewRunId. */
  origin?: MemoryWrittenFact["payload"]["origin"];
  /** Reports each landed write; the review uses it to collect its actions. */
  onWritten?: (action: { target: LearningScope; action: string; mutationEvidence?: MutationEvidence }) => void;
  /** Read side of the workspace event store. A journal replay asks it whether
   *  a journalled append already landed; a context without it leaves pending
   *  facts for a session that has one. */
  store?: AsyncEventStateReadSurface;
  /** Startup-selected account home (ARCH-DIRECTORIES-002) the global memory store hangs off. */
  accountHome: string;
}

/** The memory tool of one runner. `has` is the tree check that its description reads (ARCH-CONTEXT-033). */
export function createMemoryTool(deps: MemoryToolDeps, has: CapabilityCheck): RuntimeTool {
  // Consecutive-failure cap, reset on any success. The tool is created per
  // runtime assembly (one user turn for chat, one attempt for workers), so
  // the counter's lifetime is one turn by construction.
  let consolidationFailures = 0;

  return {
    name: "memory",
    action: "ui_meta",
    description: description(has),
    inputSchema: INPUT_SCHEMA,
    isConcurrencySafe: true,
    execute: async (input, context) => {
      if (normalizeMemoryTitle(input.title) === null) {
        return errorResult("title must be a short one-line summary with visible text.");
      }
      // Project memory belongs to the project, never to the directory this
      // call happens to execute in.
      const config = createMemoryStoreConfig(context.projectRoot, deps.accountHome);

      // Strict providers fill optional fields with null; treat as omitted.
      // Project is the defensive default: the narrowest correct reach.
      const target = input.target ?? "project";
      if (target !== "project" && target !== "global") {
        return errorResult(`Invalid target ${JSON.stringify(target)}. Use 'project' or 'global'.`);
      }

      // Every write is attributable or it does not happen: the origin names the
      // session whose aggregate holds the fact. The tool context's sessionId is
      // the conversation id, so it is never a substitute.
      const origin = deps.origin ?? (deps.sessionId ? { kind: "agent" as const, sessionId: deps.sessionId } : undefined);
      if (!origin) {
        return errorResult("This runtime names no session, so a memory write could not be attributed to one. Nothing was written.");
      }

      const call = parseCall(config, target, input);
      if (call.kind === "error") return errorResult(call.message);
      if (call.kind === "recovery") return { content: call.body, outcome: "error" };

      // The audit fact is journalled beside the store before the bytes land, so
      // a crash after publication loses no evidence, and anything an earlier
      // crash left is replayed here by the next writer of the same workspace.
      const writer = context.sessionEventWriter;
      const memoryPath = memoryStorePath(config, target);
      const storeDir = dirname(memoryPath);
      const location = config.locations[target];
      requireContainedDirectory(location.baseDir, dirname(location.relativePath));
      const auditReader = context.projectionReader ?? deps.store;
      if (writer && auditReader) {
        await reconcilePendingAudits({ storeDir, workspace: context.projectRoot, writer, reader: auditReader });
      }
      let pending: PendingAudit | undefined;
      const beforePublish = (publication: MemoryPublication): void => {
        pending = openPendingAudit({
          storeDir,
          workspace: context.projectRoot,
          fact: memoryWrittenFact({
            target,
            action: call.action,
            origin,
            // Identity of this one write, journalled with the fact: a replay
            // after a crash matches it against the store instead of appending
            // the same evidence twice.
            mutationId: randomUUID(),
            contentHash: publication.contentHash,
          }),
          // The entry is true once the store file holds exactly this content.
          // The pre-state is carried with it, so a replay can tell a write that
          // never landed from one a later write has already moved past: the
          // first is dropped, the second keeps its evidence.
          intended: {
            kind: "file",
            path: memoryPath,
            sha256: publication.contentHash,
            previous: publication.previousSha256,
          },
        });
      };

      const result = call.kind === "batch"
        ? await applyMemoryBatch(config, target, call.operations, beforePublish)
        : await applyMemoryOperation(config, target, call.operation, beforePublish);
      const audit = { writer, pending: () => pending };
      return render(result, target, call.action, audit, deps, () => consolidationFailures, (value) => { consolidationFailures = value; });
    },
  };
}

type ParsedCall =
  | { kind: "single"; action: MemoryOperation["action"]; operation: MemoryOperation }
  | { kind: "batch"; action: "batch"; operations: MemoryOperation[] }
  | { kind: "recovery"; body: string }
  | { kind: "error"; message: string };

function parseCall(config: MemoryStoreConfig, target: LearningScope, input: RuntimeToolInput): ParsedCall {
  if (Array.isArray(input.operations) && input.operations.length > MAX_MEMORY_BATCH_OPERATIONS) {
    return {
      kind: "error",
      message: `operations list has ${input.operations.length} items; maximum is ${MAX_MEMORY_BATCH_OPERATIONS}.`,
    };
  }
  if (Array.isArray(input.operations) && input.operations.length > 0) {
    const operations: MemoryOperation[] = [];
    for (const [index, raw] of input.operations.entries()) {
      const parsed = parseOperation(raw);
      if (!parsed) return { kind: "error", message: `Operation ${index + 1}: unknown or malformed. Each item is {action: add|replace|remove, content?, old_text?}.` };
      operations.push(parsed);
    }
    return { kind: "batch", action: "batch", operations };
  }

  const action = typeof input.action === "string" ? input.action : "";
  const content = typeof input.content === "string" ? input.content : "";
  const oldText = typeof input.old_text === "string" ? input.old_text : "";

  if (action === "add") {
    if (!content) return { kind: "error", message: "Content is required for 'add' action." };
    return { kind: "single", action, operation: { action, content } };
  }
  if (action === "replace" || action === "remove") {
    // Some structured-output clients omit optional fields entirely. A bare
    // "old_text is required" is a dead end; return the inventory plus a retry
    // instruction so the model can reissue with old_text set.
    if (!oldText) return { kind: "recovery", body: missingOldTextBody(config, target, action) };
    if (action === "replace") {
      if (!content) return { kind: "error", message: "content is required for 'replace' action." };
      return { kind: "single", action, operation: { action, oldText, content } };
    }
    return { kind: "single", action, operation: { action, oldText } };
  }
  return { kind: "error", message: `Unknown action ${JSON.stringify(input.action)}. Use add, replace, or remove, or pass an 'operations' batch.` };
}

interface ParsedMemoryOperation {
  readonly action?: unknown;
  readonly content?: unknown;
  readonly old_text?: unknown;
}

function parseOperation(raw: unknown): MemoryOperation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed: ParsedMemoryOperation = raw;
  const text = (value: unknown): string => typeof value === "string" ? value : "";
  // Field presence is validated in the store with positioned errors; here only
  // the shape must hold. Missing fields become empty strings the store names.
  if (parsed.action === "add") return { action: parsed.action, content: text(parsed.content) };
  if (parsed.action === "replace") return { action: parsed.action, oldText: text(parsed.old_text), content: text(parsed.content) };
  if (parsed.action === "remove") return { action: parsed.action, oldText: text(parsed.old_text) };
  return null;
}

function missingOldTextBody(config: MemoryStoreConfig, target: LearningScope, action: string): string {
  const inventory = readMemoryInventory(config, target);
  return JSON.stringify({
    success: false,
    error: `'${action}' needs old_text - a short unique substring of the entry to ${action}. None was provided. Reissue the ${action} with old_text set to part of one of the current_entries below.`,
    current_entries: inventory.entries,
    usage: inventory.usage,
  });
}


interface MemoryAudit {
  readonly writer: SessionFactWriter | undefined;
  readonly pending: () => PendingAudit | undefined;
}

/** Record the mutation's journalled audit evidence and wait for it. The store
 *  file is the artifact, but a mutation the event store never accepted is
 *  unattributable (ARCH-LEARNING-007), so a write whose evidence this runtime
 *  could not record - because the append failed, or because it records nothing
 *  at all - is reported as non-success. Terminal for this call: the bytes are
 *  already published, so a retry would duplicate the entry, and the journalled
 *  fact is replayed by the next writer of this workspace instead. */
async function settleWriteEvidence(audit: MemoryAudit, target: LearningScope): Promise<ToolResult | undefined> {
  const pending = audit.pending();
  const writer = audit.writer;
  if (!pending) return undefined;
  if (writer && await settlePendingAudit(pending, writer)) return undefined;
  log.warn("memory.written fact deferred to the audit journal", { target });
  return {
    content: JSON.stringify({
      success: false,
      done: true,
      target,
      error: "The entry is saved on disk and its memory.written evidence is journalled for recovery, but this session could not record it, so the write is not attributable yet. Do not repeat the call - it would duplicate the entry. Tell the user the audit record is pending.",
    }),
    outcome: "error",
  };
}

async function render(
  result: MemoryMutationResult,
  target: LearningScope,
  action: string,
  audit: MemoryAudit,
  deps: MemoryToolDeps,
  failures: () => number,
  setFailures: (value: number) => void,
): Promise<ToolResult> {
  switch (result.kind) {
    case "written": {
      setFailures(0);
      const auditFailure = await settleWriteEvidence(audit, target);
      let mutationEvidence: MutationEvidence | undefined;
      let evidenceFailure = false;
      try {
        const stage = audit.writer?.stageSessionContentNodes;
        if (!stage) throw new Error("Session content staging is unavailable");
        mutationEvidence = await buildMutationDiffEvidence(result.diff, randomUUID(), stage.bind(audit.writer));
      } catch {
        evidenceFailure = true;
      }
      deps.onWritten?.({ target, action, ...(mutationEvidence ? { mutationEvidence } : {}) });
      if (auditFailure) return auditFailure;
      if (evidenceFailure) return errorResult(`${result.message} Change evidence is unavailable. The write is complete, do not repeat it.`);
      return {
        content: JSON.stringify({
          success: true,
          done: true,
          target,
          usage: result.usage,
          entry_count: result.entryCount,
          message: result.message,
          // Terminal on purpose: echoing the entry list invites the model to
          // "find more to fix" and re-issue the same operations.
          note: "Write saved. This update is complete - do not repeat it.",
        }),
        outcome: "ok",
        details: { mutationEvidence },
      };
    }
    case "noop": {
      setFailures(0);
      return {
        content: JSON.stringify({ success: true, done: true, target, usage: result.usage, entry_count: result.entryCount, message: result.message, note: "This update is complete - do not repeat it." }),
        outcome: "ok",
      };
    }
    case "refused": {
      if (result.consolidation) {
        setFailures(failures() + 1);
        if (failures() > MAX_CONSOLIDATION_FAILURES_PER_TURN) {
          return {
            content: JSON.stringify({
              success: false,
              done: true,
              error: `Memory consolidation failed ${failures()} times this turn. Stop retrying memory calls - leave memory unchanged for now and continue with your reply to the user. The fact can be saved in a later turn.`,
            }),
            outcome: "error",
          };
        }
      }
      return {
        content: JSON.stringify({
          success: false,
          error: result.error,
          ...(result.currentEntries ? { current_entries: result.currentEntries } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.matches ? { matches: result.matches } : {}),
        }),
        outcome: "error",
      };
    }
  }
}

function errorResult(message: string): ToolResult {
  return { content: JSON.stringify({ success: false, error: message }), outcome: "error" };
}
