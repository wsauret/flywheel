import * as os from "node:os";

import { unguardedSpawnOwned } from "../../../../helpers/real-process-fixture.js";
import { capabilityAccessFor, type CapabilityAccess, type ToolContext, type ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { CapabilityGrant } from "../../../../../src/orchestration/config/module-policy.js";
import type { ModuleId } from "../../../../../src/orchestration/modules.js";
import type { InFlightWrite, StoredFact } from "../../../../../src/infra/event-store-types.js";
import { parseFileMutationFact, type FileMutationFact } from "../../../../../src/orchestration/session/file-mutation-facts.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { createExperimentOperation } from "../../../../../src/orchestration/modules/experiments/operation-owner.js";
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts.js";
import { moduleDisabledReason } from "../../../../../src/protocol/module-ids"
import type { SessionContentNode } from "../../../../../src/infra/session-content.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"

/** A capability boundary over one selection, optionally under a grant an
 *  operation was already admitted with. `admissions` records every operation
 *  that asked, so a case can prove a call admitted once or not at all. */
export function capabilityAccessHolding(
  held: readonly ModuleId[],
  grant?: CapabilityGrant,
): CapabilityAccess & { readonly admissions: string[] } {
  const admissions: string[] = [];
  const access = capabilityAccessFor({
    state: () => testGrant("test selection", [], held),
    admit: async (request) => {
      admissions.push(request.operation);
      const missing = request.required.filter((capability) => !held.includes(capability));
      return missing.length === 0
        ? { ok: true, grant: testGrant(request.operation, request.required, held) }
        : { ok: false, missing, reason: `${request.operation} is unavailable: ${moduleDisabledReason(missing)}` };
    },
  }, grant);
  return Object.assign(access, { admissions });
}

/** A grant as the policy mints one: the requirement set it authorizes plus the
 *  descriptor that satisfied it, as evidence. */
export function testGrant(
  operation: string,
  required: readonly ModuleId[],
  capabilities: readonly ModuleId[] = required,
): CapabilityGrant {
  return {
    operation,
    required,
    moduleIds: capabilities,
    capabilities,
    requireWorkflowConfirmation: true,
    workflowsMode: capabilities.includes("workflows") && capabilities.includes("skills") ? "ask" : "off",
    identity: `${capabilities.join("+")}|confirm|`,
  };
}

export function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    executionCwd: os.tmpdir(),
    userDataRoot: `${os.tmpdir()}/.test-account`, projectRoot: os.tmpdir(),
    artifactScopeId: "test-artifacts",
    retrievalSessionId: "test-retrieval",
    // Production always hands tools a launcher; a test that wants a container
    // it can inspect passes its own.
    spawnOwned: unguardedSpawnOwned(),
    // The exposure planner resolves the `edit` registration to either presentation.
    // Tests construct tools directly, so the fixture supplies that mapping.
    toolNames: { logical: (name) => name === "apply_patch" ? "edit" : name, presented: (name) => name },
    ...overrides,
  };
}

/** The stored form of an experiment fact, for a writer double that acknowledges every record. */
export function storedExperimentFact(fact: ExperimentFact): StoredFact {
  return { aggregateId: "session:test", sessionId: "test", id: "test-1", position: 1, seq: 0, timestamp: 1, type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload };
}

/** An operation with no hold at open whose hold writes succeed. It records
 *  no fact, so a case that stops it must build its own. */
export function testExperimentOperation() {
  return createExperimentOperation({
    listInFlight: async () => [],
    putInFlight: async () => {},
    record: async () => { throw new Error("unexpected experiment fact"); },
  });
}

/** The path lines of a list result, without its notes. */
export function pathLines(content: ToolResult["content"]): string[] {
  if (typeof content !== "string") throw new Error("list answers with text");
  return content.split("\n").filter((line) => line && !line.startsWith("[") && line !== "No paths found.");
}

type FileChangedFact = Extract<FileMutationFact, { type: "file.changed" }>;

export function createRecordingFileMutationStore() {
  const changes: FileChangedFact["payload"][] = [];
  const facts: Array<Parameters<SessionFactWriter["record"]>[0]> = [];
  let seq = 0;
  const stored = (fact: Parameters<SessionFactWriter["record"]>[0]): StoredFact => ({
    aggregateId: "session:test",
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId: "test",
    payload: fact.payload,
    position: seq + 1,
    id: `event-${seq + 1}`,
    seq: seq++,
  });
  // Preparations are in-flight state now, not facts: the double records them
  // where the store would, so a test can still assert a mutation was prepared
  // before its bytes were published.
  const prepared: Array<{ kind: string; key: string; payload: unknown }> = [];
  const inFlight = new Map<string, string>();
  const contentNodes = new Map<string, SessionContentNode>();
  const applyInFlight = (transition: InFlightWrite): void => {
    switch (transition.op) {
      case "put":
        inFlight.set(`${transition.kind}:${transition.key}`, JSON.stringify(transition.payload));
        prepared.push({ kind: transition.kind, key: transition.key, payload: transition.payload });
        break;
      case "drop":
        inFlight.delete(`${transition.kind}:${transition.key}`);
        prepared.push({ kind: transition.kind, key: transition.key, payload: null });
        break;
      case "clear":
        for (const key of inFlight.keys()) if (key.startsWith(`${transition.kind}:`)) inFlight.delete(key);
        break;
      case "clear_session":
        inFlight.clear();
        break;
      case "swap": {
        const compound = `${transition.kind}:${transition.key}`;
        if (transition.payload === null) inFlight.delete(compound);
        else inFlight.set(compound, JSON.stringify(transition.payload));
        prepared.push({ kind: transition.kind, key: transition.key, payload: transition.payload });
        break;
      }
    }
  };
  const writer: SessionFactWriter & Required<Pick<SessionFactWriter, "stageSessionContentNodes">> = {
    stageSessionContentNodes: async nodes => { for (const row of nodes) contentNodes.set(row.sha256, row.node) },
    recordBatch: async () => { throw new Error("unused request audit"); },
    putInFlight: async (kind, key, payload) => { applyInFlight({ op: "put", kind, key, payload }); },
    swapInFlight: async (kind, key, expectedRaw, payload) => {
      const compound = `${kind}:${key}`;
      if ((inFlight.get(compound) ?? null) !== expectedRaw) return false;
      applyInFlight({ op: "swap", kind, key, expectedRaw, payload });
      return true;
    },
    record: async (fact, _contentRows, transitions) => {
      facts.push(fact);
      if (fact.type === "file.changed") {
        const parsed = parseFileMutationFact(fact)
        if (parsed.type === "file.changed") changes.push(parsed.payload)
      }
      for (const transition of transitions ?? []) applyInFlight(transition);
      return stored(fact);
    },
    recordGuarded: async (fact, _expectedSeq) => ({ kind: "stored", events: [stored(fact)] }),
    transaction: async fn => { fn(); },
    dispose: () => {},
  };
  return {
    facts,
    changes,
    prepared,
    writer,
    readContentNode: async (sha256: string) => contentNodes.get(sha256) ?? null,
    reader: asAsyncEventReadSurface({
      ...inMemoryEventReader([]),
      readSessionContentNode: (_sessionId, sha256) => contentNodes.get(sha256) ?? null,
    }),
  };
}
