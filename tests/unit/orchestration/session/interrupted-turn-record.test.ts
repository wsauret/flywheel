import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import { interruptedTurnEnd, turnEndOfEntry, type TurnInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record";
import {
  assistantToolUseMessage,
  attachingProcess,
  createSavePointContext,
  disposeSavePointContext,
  toolResultMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";

// The model reads the interrupt record to decide what it may repeat. It says
// a tool call was cut only when the cut turn recorded an interrupted tool
// result; a cut model stream after every command finished says only who
// interrupted. Every caller (chat, workflow step, follow-up, subagent) writes
// through the controller's commitTurnEnd, so these cases cover each of the
// orders those callers produce. A planned replacement's cut is saved as the
// runtime's interrupt, marked planned, and its text follows the same rule.

const CUT_CLAIM = "A tool call that was running was cut";

let ctx: SavePointTestContext;
let writer: ConversationTreeWriterController;

beforeEach(async () => {
  ctx = await createSavePointContext();
  writer = createConversationTreeWriterController({
    conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
  });
});

afterEach(async () => {
  await writer.dispose();
  await disposeSavePointContext(ctx);
});

function interruptedResult(toolUseId: string): ConversationMessage {
  return { kind: "toolResult", toolUseId, content: [{ type: "text", text: "Tool 'search' was interrupted before a result was recorded." }], interrupted: true };
}

/** The turn's committed record text, read back as a successor would, after
 *  checking that the record saves the turn end `by` records. */
async function landedRecord(by: TurnInterruption): Promise<string> {
  const branch = await (await attachingProcess(ctx)).getBranch();
  const records = branch.filter((entry) => entry.kind === "message" && turnEndOfEntry(entry) !== undefined);
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record?.kind !== "message") throw new Error("no turn-end record landed");
  expect(turnEndOfEntry(record)).toEqual(interruptedTurnEnd(by));
  return typeof record.message.content === "string" ? record.message.content : "";
}

/** A turn that ran one tool call; the call finished or was cut. */
async function runToolTurn(result: ConversationMessage): Promise<void> {
  await writer.commitUserTurn("fix the parser");
  writer.beginTurn();
  await writer.recordCanonicalMessage(assistantToolUseMessage("call-1"));
  await writer.recordCanonicalMessage(result);
}

const INTERRUPTERS: TurnInterruption[] = ["person", "runtime", "replacement", "close"];

describe.each(INTERRUPTERS)("the record of a turn interrupted by the %s", (by) => {
  const who = by === "person" ? "The user interrupted this turn"
    : by === "close" ? "The runtime interrupted this turn before it finished, because the user closed the chat."
    : "The runtime interrupted this turn";

  it("a cut running tool call is stated, in the loop's copy and the tree alike (chat, step, and follow-up park)", async () => {
    await runToolTurn(interruptedResult("call-1"));
    const held = await writer.commitTurnEnd(by);
    await writer.flushSavePoint();
    expect(held.content).toContain(who);
    expect(held.content).toContain(CUT_CLAIM);
    expect(await landedRecord(by)).toBe(String(held.content));
  });

  it("a cut model stream after every command finished states only who interrupted (chat, step, and follow-up park)", async () => {
    await runToolTurn(toolResultMessage("call-1", "done"));
    await writer.flushSavePoint();
    const held = await writer.commitTurnEnd(by);
    await writer.flushSavePoint();
    expect(held.content).toContain(who);
    expect(held.content).not.toContain(CUT_CLAIM);
    expect(await landedRecord(by)).toBe(String(held.content));
  });

  it("a record written while the cut turn still settles reads the results that land ahead of it (runtime cut)", async () => {
    await writer.commitUserTurn("fix the parser");
    writer.beginTurn();
    await writer.recordCanonicalMessage(assistantToolUseMessage("call-1"));
    await writer.commitTurnEnd(by);
    // The cut tool settles after the record was asked for.
    await writer.recordCanonicalMessage(interruptedResult("call-1"));
    await writer.endTurn();
    const landed = await landedRecord(by);
    expect(landed).toContain(who);
    expect(landed).toContain(CUT_CLAIM);
  });

  it("a record written after the turn ended reads its committed results (subagent pause)", async () => {
    await runToolTurn(toolResultMessage("call-1", "done"));
    await writer.endTurn();
    const record = await writer.commitTurnEnd(by);
    expect(record.content).not.toContain(CUT_CLAIM);
    expect(await landedRecord(by)).toBe(String(record.content));
  });
});

describe("the record of an interrupted turn", () => {
  it("a finished tool batch of an earlier, resumed turn is not this turn's cut", async () => {
    await runToolTurn(interruptedResult("call-1"));
    await writer.commitTurnEnd("person");
    await writer.flushSavePoint();
    await writer.endTurn();
    await writer.commitSystemTurn("Continue the interrupted turn.");
    writer.beginTurn();
    await writer.commitTurnEnd("runtime");
    await writer.endTurn();
    const branch = await (await attachingProcess(ctx)).getBranch();
    const records = branch.flatMap((entry) => entry.kind === "message" && turnEndOfEntry(entry) !== undefined ? [String(entry.message.content)] : []);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain(CUT_CLAIM);
    expect(records[1]).not.toContain(CUT_CLAIM);
  });

  it("records asked for while the turn runs land in the order they were asked for, however long each one's read of the branch takes, so a person's interrupt after the runtime's cut is the last turn end", async () => {
    await writer.commitUserTurn("fix the parser");
    writer.beginTurn();
    const readBranch = ConversationTree.prototype.getBranch;
    const slowRead = Promise.withResolvers<void>();
    const branchReads = spyOn(ConversationTree.prototype, "getBranch").mockImplementationOnce(async function (this: ConversationTree) {
      await slowRead.promise;
      return readBranch.call(this);
    });
    const cut = writer.commitTurnEnd("replacement");
    await writer.commitTurnEnd("person");
    slowRead.resolve();
    await cut;
    branchReads.mockRestore();
    await writer.endTurn();
    const branch = await (await attachingProcess(ctx)).getBranch();
    const ends = branch.flatMap((entry) => entry.kind === "message" ? [turnEndOfEntry(entry)].filter((end) => end !== undefined) : []);
    expect(ends).toEqual([interruptedTurnEnd("replacement"), interruptedTurnEnd("person")]);
  });
});
