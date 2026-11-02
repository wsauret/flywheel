import type { NestedToolFactPublisher } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";

const FIXTURE_SECRET = ["Bearer", "fixturevalue123"].join(" ");

/** One nested result whose text parts hold a credential and about 160 KB of ordinary text. */
export function largeSecretResult(id: string): Parameters<NestedToolFactPublisher["result"]> {
  return [{ id, name: "probe", input: {} }, {
    content: [{ type: "text", text: `${id}\n${FIXTURE_SECRET}\n${"payload ".repeat(20_000)}` }, { type: "text", text: FIXTURE_SECRET }],
    outcome: "ok",
  }, { parentToolUseId: "outer" }];
}

/** A fact writer that records `<toolUseId>:redacted` or `<toolUseId>:raw` for each fact it stores, and refuses to store the facts of the refused tool use. */
export function resultRecordingWriter(records: string[], refusedToolUseId?: string): SessionFactWriter {
  return {
    recordBatch: async () => { throw new Error("unused request audit"); },
    record: async (fact, contentRows) => {
      const toolUseId = "toolUseId" in fact.payload ? String(fact.payload.toolUseId) : "none";
      if (toolUseId === refusedToolUseId) return null;
      const stored = JSON.stringify([fact.payload, contentRows]);
      const redacted = stored.includes("[redacted secret]") && !stored.includes(FIXTURE_SECRET);
      records.push(`${toolUseId}:${redacted ? "redacted" : "raw"}`);
      return { aggregateId: "session:session", type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor,
        sessionId: "session", payload: fact.payload, position: records.length, id: `event-${records.length}`, seq: records.length };
    },
    recordGuarded: async () => null,
    transaction: async (fn) => { fn(); },
    dispose: () => {},
  };
}
