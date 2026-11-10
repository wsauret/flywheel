import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { createConversationCheckpointOwner, emptyConversationCheckpoint, readConversationCheckpoint, renderApprovedCheckpointIntent } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import { importLegacyCheckpointNotes } from "../../../../../src/orchestration/session/checkpoint-note-conversion.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { prepareToolCall, executePreparedTool } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { makeContext } from "./_fixtures.js";
import { promptCapabilities } from "../../../../helpers/prompt-capabilities.js";
import { resolveConversationResources } from "../../../../../src/orchestration/session/conversation-resources.js";
import { ConversationTreeStorage } from "../../../../../src/orchestration/session/conversation/conversation-tree-storage.js";
import { ConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree.js";

describe("conversation checkpoint tools", () => {
  const temporaryDirectory = temporaryDirectories();
  const stores: LocalSqliteEventStore[] = [];
  afterEach(() => { for (const store of stores.splice(0)) store.close(); });
  function fixture() {
    const root = temporaryDirectory("checkpoint-tools-");
    const store = createSqliteEventStore(join(root, "events.sqlite"));
    stores.push(store);
    const reader = asAsyncEventReadSurface(store);
    const writer = createSessionFactWriter({ sessionId: "session", writer: asAsyncEventWriter(store) });
    const owner = createConversationCheckpointOwner(reader, writer, { kind: "session", sessionId: "session" }, "conversation");
    const plan = () => planToolExposure({ kernel: testKernelToolDeps({ userDataRoot: root, checkpoint: owner }), modules: NO_MODULE_RUNTIMES, selected: new Set<string>() });
    return { root, store, reader, writer, owner, plan };
  }
  it("exposes only own-conversation checkpoint tools independently of file selection", async () => {
    const { plan } = fixture();
    const tools = (await plan()).tools;
    expect([...tools.keys()].filter((name) => name.startsWith("checkpoint_"))).toEqual(["checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    expect([...tools.keys()].some((name) => name.startsWith("note_"))).toBe(false);
    const absent = await planToolExposure({ kernel: testKernelToolDeps(), modules: NO_MODULE_RUNTIMES });
    expect(absent.tools.has("checkpoint_replace")).toBe(false);
  });
  it("replaces one typed section, records exact decisions, and isolates another conversation", async () => {
    const { root, owner, reader, plan } = fixture();
    const tools = (await plan()).tools;
    const context = makeContext({ executionCwd: root, capabilities: promptCapabilities([{ name: "skill" }]) });
    const run = (name: string, input: { [key: string]: unknown }) => executePreparedTool(prepareToolCall({ id: name, name, input }, tools), context);
    expect((await run("checkpoint_replace", { section: "designIntent", value: { text: "Keep all decisions.", approved: true } })).outcome).toBe("ok");
    expect((await run("checkpoint_decide", { date: "2026-10-21", words: "Use the exact words.", replaces: "Summarize the decision." })).outcome).toBe("ok");
    expect((await run("checkpoint_replace", { section: "nextStep", value: "Run the focused check." })).outcome).toBe("ok");
    const saved = await owner.read();
    expect(saved).toEqual({ ...emptyConversationCheckpoint(), designIntent: { text: "Keep all decisions.", approved: true }, decisions: [{ date: "2026-10-21", words: "Use the exact words.", replaces: "Summarize the decision." }], nextStep: "Run the focused check." });
    expect(await readConversationCheckpoint(reader, { kind: "session", sessionId: "session" }, "other")).toBeUndefined();
    const read = await run("checkpoint_read", {});
    expect(read.content).toContain("# Design intent (approved)\n\nKeep all decisions.");
    expect(read.content).toContain("# Relevant skills");
    expect(read.content).toContain("# Working notes");
    // An agent that cannot load skills reads no empty Relevant skills section; every other section stays.
    const unskilled = await executePreparedTool(prepareToolCall({ id: "read", name: "checkpoint_read", input: {} }, tools), makeContext({ executionCwd: root, capabilities: promptCapabilities([]) }));
    expect(unskilled.content).not.toContain("# Relevant skills");
    expect(unskilled.content).toContain("# References");
    expect(await run("checkpoint_read", { section: "nextStep" })).toMatchObject({ outcome: "ok", content: JSON.stringify("Run the focused check.") });
    expect(await run("checkpoint_read", { section: "designIntent" })).toMatchObject({ outcome: "ok", content: JSON.stringify({ text: "Keep all decisions.", approved: true }) });
    expect((await run("checkpoint_read", { section: "nextStep", offset: 0 })).outcome).toBe("error");
    expect((await run("checkpoint_replace", { section: "designIntent", value: { approved: true } })).outcome).toBe("error");
    expect((await run("checkpoint_replace", { section: "designIntent", value: { text: "Changed.", approved: true, by: "agent" } })).outcome).toBe("error");
    expect((await run("checkpoint_replace", { section: "nextStep", value: "changed", conversationId: "other" })).outcome).toBe("error");
    expect(await owner.read()).toEqual(saved);
    expect(renderApprovedCheckpointIntent(saved!)).toContain("Use the exact words.");
    expect(renderApprovedCheckpointIntent({ ...saved!, designIntent: { text: "draft", approved: false } })).toBeUndefined();
  });
  it("saves a design intent without an approval as a draft that no child inherits", async () => {
    const { root, owner, plan } = fixture();
    const tools = (await plan()).tools;
    const run = (value: unknown) => executePreparedTool(prepareToolCall({ id: "replace", name: "checkpoint_replace", input: { section: "designIntent", value } }, tools), makeContext({ executionCwd: root }));
    // A design intent sent as JSON text is read as its object, not saved as that text.
    for (const value of [{ text: "Draft the plan." }, "Draft the plan.", JSON.stringify({ text: "Draft the plan." })]) {
      await owner.replace("designIntent", { text: "Approved earlier.", approved: true });
      expect(await run(value)).toMatchObject({ outcome: "ok", content: expect.stringMatching(/Checkpoint saved\.$/) });
      const saved = await owner.read();
      expect(saved?.designIntent).toEqual({ text: "Draft the plan.", approved: false });
      expect(renderApprovedCheckpointIntent(saved!)).toBeUndefined();
    }
  });
  it("reads a structured section sent as JSON text and keeps JSON-looking text sections as written", async () => {
    const { root, owner, plan } = fixture();
    const tools = (await plan()).tools;
    const run = (input: { [key: string]: unknown }) => executePreparedTool(prepareToolCall({ id: "replace", name: "checkpoint_replace", input }, tools), makeContext({ executionCwd: root }));
    expect(await run({ section: "designIntent", value: JSON.stringify({ text: "Keep all decisions.", approved: "false" }) })).toMatchObject({ outcome: "ok", content: "Note: the text value of `value` was read as an object.\nNote: the text value of `value.approved` was read as a boolean.\nCheckpoint saved." });
    expect((await run({ section: "references", value: "[\"entry-1\"]" })).content).toBe("Note: the text value of `value` was read as a list.\nCheckpoint saved.");
    expect(await run({ section: "workingNotes", value: "{\"raw\": true}" })).toMatchObject({ outcome: "ok", content: "Checkpoint saved." });
    expect(await owner.read()).toMatchObject({ designIntent: { text: "Keep all decisions.", approved: false }, references: ["entry-1"], workingNotes: "{\"raw\": true}" });
  });
  it("refuses a UTF-8 checkpoint above 24 KiB without changing history", async () => {
    const { owner, store } = fixture();
    const overhead = Buffer.byteLength(JSON.stringify(emptyConversationCheckpoint()));
    const text = "é".repeat(Math.floor((24_576 - overhead) / 2)) + "a".repeat((24_576 - overhead) % 2);
    await owner.replace("workingNotes", text);
    await expect(owner.replace("workingNotes", `${text}x`)).rejects.toThrow("Checkpoint is 24577 bytes; the limit is 24576 bytes. Sections, largest first: workingNotes 24414. Curate");
    expect((await owner.read())?.workingNotes).toBe(text);
    expect(store.read({ aggregateId: "session:session", types: ["conversation.checkpoint.updated"] })).toHaveLength(1);
  });
  it("keeps every version inspectable and the latest checkpoint current across rewind", async () => {
    const { owner, store, reader } = fixture();
    const storage = await ConversationTreeStorage.create({ store: reader, writer: asAsyncEventWriter(store), sessionId: "session", conversationId: "conversation" });
    const tree = new ConversationTree(storage);
    const first = await tree.appendMessage({ kind: "user", content: "first" });
    await owner.replace("currentState", "before");
    await tree.appendMessage({ kind: "assistant", content: "after" });
    await owner.replace("currentState", "after");
    await tree.moveTo(first);
    expect((await owner.read())?.currentState).toBe("after");
    const versions = store.read({ aggregateId: "session:session", types: ["conversation.checkpoint.updated"] });
    expect(versions.map((event) => event.payload.checkpoint)).toEqual([
      { ...emptyConversationCheckpoint(), currentState: "before" }, { ...emptyConversationCheckpoint(), currentState: "after" },
    ]);
    storage.dispose();
  });
  it("imports every legacy Markdown file verbatim once, even above the write limit", async () => {
    const { root, reader, writer, owner, plan } = fixture();
    const notes = resolveConversationResources(join(root, "session"), "conversation").notesDirectory!;
    mkdirSync(join(notes, "nested"), { recursive: true });
    const first = "\uFEFF# Original\n\nDo not change  spaces.\r\n";
    const second = `${"\0é\u{1D11E}".repeat(6_000)}unique middle${"x".repeat(30_000)}`;
    writeFileSync(join(notes, "one.md"), first);
    writeFileSync(join(notes, "nested", "two.md"), second);
    await importLegacyCheckpointNotes(reader, writer, { kind: "session", sessionId: "session" }, "conversation", notes);
    const imported = `## nested/two.md\n\n${second}\n\n## one.md\n\n${first}`;
    expect((await owner.read())?.workingNotes).toBe(imported);
    const tools = (await plan()).tools;
    const context = makeContext({ executionCwd: root, capabilities: promptCapabilities([]) });
    const read = (input: { [key: string]: unknown }) => executePreparedTool(prepareToolCall({ id: "read", name: "checkpoint_read", input }, tools), context);
    const overview = await read({});
    expect(overview.outcome).toBe("ok");
    if (typeof overview.content !== "string") throw new Error("expected a text checkpoint overview");
    expect(overview.content).toContain('checkpoint_read({ "section": "workingNotes", "offset": 0 })');
    expect(overview.content).toContain(`${Buffer.byteLength(imported, "utf8")} bytes`);
    expect(overview.content).not.toContain("unique middle");
    expect(Buffer.byteLength(overview.content, "utf8")).toBeLessThan(30_000);
    let recovered = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await read({ section: "workingNotes", offset });
      expect(result.outcome).toBe("ok");
      if (typeof result.content !== "string") throw new Error("expected a text checkpoint page");
      expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(30_000);
      const page = JSON.parse(result.content);
      expect(typeof page.content).toBe("string");
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
      recovered += page.content;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(imported);
    expect(recovered).toContain("unique middle");
    expect((await read({ section: "workingNotes", offset: -1 })).outcome).toBe("error");
    expect(readFileSync(join(notes, "one.md"), "utf8")).toBe(first);
    writeFileSync(join(notes, "one.md"), "changed old file");
    await importLegacyCheckpointNotes(reader, writer, { kind: "session", sessionId: "session" }, "conversation", notes);
    expect((await owner.read())?.workingNotes).toContain(first);
    await expect(owner.replace("nextStep", "too large until curated")).rejects.toThrow(/Sections, largest first: workingNotes \d+, nextStep 25\. Curate the largest sections with checkpoint_replace/);
    await owner.replace("workingNotes", first);
    expect((await owner.read())?.workingNotes).toBe(first);
  });
});
