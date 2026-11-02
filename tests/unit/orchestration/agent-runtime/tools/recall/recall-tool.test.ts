import { describe, it, expect } from "bun:test";
import { createRecallTool } from "../../../../../../src/orchestration/agent-runtime/tools/recall.js";
import type { RecallPort } from "../../../../../../src/protocol/conversation-recall.js";
import { makeContext } from "../_fixtures.js";

const ctx = makeContext();

const capability: RecallPort = async (input) => {
  if (input.scope === "lineage" && input.query === "secret") return { hits: [], totalMatches: 0 };
  if (input.scope === "all" && input.query === "secret") {
    return { hits: [{ index: 1, entryId: "fork", role: "user", summary: "off lineage secret", snippet: "off lineage [secret]" }], totalMatches: 1 };
  }
  if (input.expand?.includes(1) && input.scope === "lineage") return { hits: [], invalidExpand: [1] };
  if (input.expand?.includes(1) && input.scope === "all") return { hits: [{ index: 1, entryId: "fork", role: "user", summary: "off lineage secret", text: "off lineage secret", totalLength: 18 }] };
  return { hits: [] };
};

describe("createRecallTool", () => {
  const tool = createRecallTool(capability);

  it("returns No matches under default lineage scope", async () => {
    const r = await tool.execute({ query: "secret" }, ctx);
    expect(typeof r.content === "string" ? r.content : "").toContain("No matches");
    expect(r.outcome).toBe("ok");
  });

  it("surfaces off-lineage results under scope all", async () => {
    const r = await tool.execute({ query: "secret", scope: "all" }, ctx);
    const text = typeof r.content === "string" ? r.content : "";
    expect(text).toContain("scope: all");
    expect(text).toContain("off lineage [secret]");
  });

  it("rejects expand of indices outside the active lineage", async () => {
    const r = await tool.execute({ expand: [1] }, ctx);
    expect(typeof r.content === "string" ? r.content : "").toContain("Cannot expand references outside active lineage: 1");
  });

  it("expands off-lineage indices under scope all", async () => {
    const r = await tool.execute({ expand: [1], scope: "all" }, ctx);
    const text = typeof r.content === "string" ? r.content : "";
    expect(text).toContain("Scope: all");
    expect(text).toContain("#1 id:fork [user] off lineage secret");
  });

  it("passes exact IDs and bounded range arguments to recall", async () => {
    let captured: Parameters<RecallPort>[0] | undefined;
    const capturingTool = createRecallTool(async (input) => {
      captured = input;
      return { hits: [] };
    });
    await capturingTool.execute({ expand: ["entry-1"], offset: 12, limit: 4000 }, ctx);
    expect(captured).toEqual({ scope: "lineage", expand: ["entry-1"], page: 1, offset: 12, limit: 4000 });
  });

  it("surfaces a recall owner error after one call", async () => {
    let calls = 0;
    const failingTool = createRecallTool(async () => {
      calls += 1;
      throw new Error("Worker recall failed");
    });

    await expect(failingTool.execute({ query: "needle" }, ctx)).rejects.toThrow("Worker recall failed");
    expect(calls).toBe(1);
  });

  it("rejects malformed and excessive expand input clearly", async () => {
    const malformed = await tool.execute({ expand: ["ok", true] }, ctx);
    expect(typeof malformed.content === "string" ? malformed.content : "").toContain("expand must contain only");
    const excessive = await tool.execute({ expand: [1, 2, 3, 4, 5, 6] }, ctx);
    expect(typeof excessive.content === "string" ? excessive.content : "").toContain("at most 5");
    const range = await tool.execute({ expand: ["ok"], offset: -1, limit: 8001 }, ctx);
    expect(typeof range.content === "string" ? range.content : "").toContain("offset must be");
  });

  it("renders pagination header and footer when results span pages", async () => {
    const paged: RecallPort = async (input) => {
      if (input.query === "many") {
        return {
          hits: [{ index: 0, entryId: "hit-id", role: "user", summary: "hit", snippet: "[hit]" }],
          totalMatches: 12,
        };
      }
      return { hits: [] };
    };
    const r = await createRecallTool(paged).execute({ query: "many" }, ctx);
    const text = typeof r.content === "string" ? r.content : "";
    expect(text).toContain("Page 1/3 (12 total matches)");
    expect(text).toContain("--- Use page:2 for more results ---");
  });
});
