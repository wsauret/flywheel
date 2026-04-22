import { describe, expect, test } from "bun:test";
import { renderWorkPostamble } from "../src/workflows/queue/shared/handoff-render";

describe("handoff render", () => {
  test("uses engine-neutral handoff wording in work postambles", () => {
    const postamble = renderWorkPostamble([{
      key: "summary",
      description: "done",
      example: "\"done\"",
      required: true,
    }], "/tmp/test-handoff.json");

    expect(postamble).toContain("handoff-writing mechanism for this engine");
    expect(postamble).not.toContain("your file-writing tool");
  });
});
