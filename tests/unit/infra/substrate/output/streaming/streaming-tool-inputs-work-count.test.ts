import { describe, expect, test } from "bun:test";
import { TopLevelJsonStringDecoder } from "../../../../../../src/infra/substrate/output/streaming/partial-json.js";
import { StreamingToolInputs } from "../../../../../../src/infra/substrate/output/streaming/streaming-tool-inputs.js";

describe("StreamingToolInputs work per delta", () => {
  test("over a streamed edit list, no delta copies more decoded fields as the list grows", () => {
    const fields = Object.getOwnPropertyDescriptor(TopLevelJsonStringDecoder.prototype, "fields");
    if (!fields?.get) throw new Error("TopLevelJsonStringDecoder has no fields accessor");
    const read = fields.get;
    let copied = 0;
    Object.defineProperty(TopLevelJsonStringDecoder.prototype, "fields", {
      ...fields,
      get(this: TopLevelJsonStringDecoder) {
        const decoded: object = read.call(this);
        copied += Object.keys(decoded).length;
        return decoded;
      },
    });
    try {
      const mostCopiedByOneDelta = [10, 200].map((count) => {
        const edits = Array.from({ length: count }, (_, item) => ({ old_string: `old ${item}`, new_string: `new ${item}` }));
        const json = JSON.stringify({ path: "src/a.ts", edits });
        const inputs = new StreamingToolInputs("/workspace");
        inputs.start("call", "edit");
        let most = 0;
        for (let at = 0; at < json.length; at += 8) {
          copied = 0;
          inputs.append("call", json.slice(at, at + 8));
          most = Math.max(most, copied);
        }
        return most;
      });
      expect(mostCopiedByOneDelta[1]).toBe(mostCopiedByOneDelta[0]);
    } finally {
      Object.defineProperty(TopLevelJsonStringDecoder.prototype, "fields", fields);
    }
  });
});
