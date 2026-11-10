import { describe, test, expect } from "bun:test";
import { MAX_STREAMING_TOOL_INPUT_BYTES, TopLevelJsonStringDecoder } from "../../../../src/infra/output/partial-json.js";
import { StreamingToolTextStore } from "../../../../src/infra/output/streaming-tool-text.js";

describe("TopLevelJsonStringDecoder", () => {
  test("exposes completed declared booleans and whole-object completion", () => {
    const decoder = new TopLevelJsonStringDecoder(["old_string", "replace_all"]);

    expect(decoder.append('{"old_string":"x","replace_all":tr')).toMatchObject({
      completedFields: ["old_string"],
      completedObject: false,
    });
    expect(decoder.field("replace_all")).toBeUndefined();
    expect(decoder.append("ue}")).toMatchObject({
      completedFields: ["replace_all"],
      completedObject: true,
    });
    expect(decoder.fields).toEqual({ old_string: "x", replace_all: true });
    expect(decoder.field("replace_all")).toBe(true);
  });

  test("exposes a declared object field once its value completes", () => {
    const decoder = new TopLevelJsonStringDecoder(["source", "summary"]);

    expect(decoder.append('{"source":{"kind":"registered","defin')).toMatchObject({ completedFields: [] });
    expect(decoder.fields).toEqual({});
    expect(decoder.append('ition_id":"implement"},"summary":"Fix')).toMatchObject({ completedFields: ["source"], additions: { summary: "Fix" } });
    expect(decoder.fields).toEqual({ source: { kind: "registered", definition_id: "implement" } });
  });

  test("does not imply an absent optional boolean until the object is complete", () => {
    const decoder = new TopLevelJsonStringDecoder(["old_string", "replace_all"]);
    expect(decoder.append('{"old_string":"x"')).toMatchObject({ completedObject: false });
    expect(decoder.completed).toBe(false);
    expect(decoder.field("replace_all")).toBeUndefined();
    expect(decoder.append("}")).toMatchObject({ completedObject: true });
    expect(decoder.completed).toBe(true);
    expect(decoder.field("replace_all")).toBeUndefined();
  });

  test("streams the declared string fields of each object item of a declared list and exposes the list whole", () => {
    const decoder = new TopLevelJsonStringDecoder(["path", "edits", "edits.*.old_string"]);
    const source = JSON.stringify({ path: "a", edits: [{ old_string: "x\"}]", other: { old_string: "nested" }, new_string: "y" }, { old_string: "\uD83D\uDE00" }] });
    const additions: { [field: string]: string } = {};
    const completed: string[] = [];
    for (const char of source) {
      const decoded = decoder.append(char);
      for (const [field, text] of Object.entries(decoded.additions)) additions[field] = (additions[field] ?? "") + text;
      completed.push(...decoded.completedFields);
    }
    expect(additions).toEqual({ path: "a", "edits.0.old_string": "x\"}]", "edits.1.old_string": "\uD83D\uDE00" });
    expect(completed).toEqual(["path", "edits.0.old_string", "edits.1.old_string", "edits"]);
    expect(decoder.field("edits.1.old_string")).toBe("\uD83D\uDE00");
    expect(decoder.fields.edits).toEqual(JSON.parse(source).edits);
    expect(decoder.completed).toBe(true);
  });

  test("decodes split escapes once and reports accepted UTF-8 bytes", () => {
    const decoder = new TopLevelJsonStringDecoder(["content"]);

    expect(decoder.append('{"content":"a\\').additions).toEqual({ content: "a" });
    expect(decoder.append('n\\uD83D').additions).toEqual({ content: "\n" });
    expect(decoder.append('\\uDE00"}').additions).toEqual({ content: "😀" });
    expect(decoder.fields).toEqual({ content: "a\n😀" });
    expect(decoder.acceptedBytes).toBe(Buffer.byteLength('{"content":"a\\n\\uD83D\\uDE00"}'));
  });

  test("fails closed after malformed top-level input", () => {
    const decoder = new TopLevelJsonStringDecoder(["content"]);

    decoder.append('["not","an","object"]');
    expect(decoder.append('{"content":"hidden"}').additions).toEqual({});
    expect(decoder.fields).toEqual({});
  });

  test("decodes only exact declared fields and rejects malformed skipped values", () => {
    const malformed = [
      '{"content":"shown","ignored":truX}',
      '{"ignored":[1,2},"content":"hidden"}',
      '{"ignored":{"nested":1],"content":"hidden"}',
    ];
    for (const source of malformed) {
      const decoder = new TopLevelJsonStringDecoder(["content"]);
      decoder.append(source);
      expect(decoder.failed).toBe(true);
      expect(decoder.fields).toEqual({});
    }

    const decoder = new TopLevelJsonStringDecoder(["content"]);
    decoder.append('{"undeclared":"secret","content":"shown"}');
    expect(decoder.fields).toEqual({ content: "shown" });
    expect(decoder.field("undeclared")).toBeUndefined();
  });

  test("processes a 1 MiB field and sanitizer in linear byte counts", () => {
    const body = "x".repeat(1024 * 1024);
    const source = `{"content":"${body}"}`;
    const decoder = new TopLevelJsonStringDecoder(["content"]);
    const store = new StreamingToolTextStore(() => {});
    for (let offset = 0; offset < source.length; offset += 128) {
      const result = decoder.append(source.slice(offset, offset + 128));
      store.append("large", result.additions.content ?? "");
    }
    expect(decoder.acceptedBytes).toBe(Buffer.byteLength(source));
    expect(store.acceptedBytes("large")).toBe(Buffer.byteLength(body));
    expect(store.snapshot().large?.content).toHaveLength(body.length);
  });

  test("fails closed when cumulative canonical input exceeds the bound", () => {
    const decoder = new TopLevelJsonStringDecoder(["content"]);
    decoder.append(`{"content":"${"x".repeat(MAX_STREAMING_TOOL_INPUT_BYTES)}`);
    expect(decoder.failed).toBe(true);
    expect(decoder.fields).toEqual({});
  });
});
