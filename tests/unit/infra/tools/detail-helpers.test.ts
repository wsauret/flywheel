import { describe, expect, it } from "bun:test";
import { listDetail, searchDetail, shellDetail, subagentDisplayLabel } from "../../../../src/infra/tools/detail-helpers.js";

describe("subagentDisplayLabel", () => {
  it("labels a general agent 'General' when fork is absent", () => {
    expect(subagentDisplayLabel({ persona: "general" })).toBe("General");
  });

  it("labels a general agent 'Fork' when fork is true", () => {
    expect(subagentDisplayLabel({ persona: "general", fork: true })).toBe("Fork");
  });

  it("degrades to 'General' when fork is a wrong-typed partial-JSON value", () => {
    expect(subagentDisplayLabel({ persona: "general", fork: "tru" })).toBe("General");
  });

  it("deslugifies other agent types", () => {
    expect(subagentDisplayLabel({ persona: "custom-scout" })).toBe("Custom Scout");
  });

  it("marks a forked persona with a fork suffix", () => {
    expect(subagentDisplayLabel({ persona: "reviewer-elegance", fork: true })).toBe("Reviewer Elegance (fork)");
  });

  it("returns null while persona has not streamed in yet", () => {
    expect(subagentDisplayLabel({})).toBeNull();
    expect(subagentDisplayLabel({ persona: 42 })).toBeNull();
  });
});

describe("searchDetail", () => {
  it("shows the head slice when a limit is set", () => {
    expect(searchDetail({ pattern: "err", path: "src", limit: 5 }, "/cwd", "glob")).toBe('"err" in src | head -5');
  });

  it("shows the tail slice for tail searches", () => {
    expect(searchDetail({ pattern: "err", path: "app.log", tail: true, limit: 40 }, "/cwd")).toBe('"err" in app.log | tail -40');
    expect(searchDetail({ pattern: "err", tail: true }, "/cwd")).toBe('"err" | tail');
  });

  it("shows count mode regardless of limit", () => {
    expect(searchDetail({ pattern: "err", output_mode: "count", limit: 5 }, "/cwd")).toBe('"err" | count');
  });

  it("omits the slice token for plain searches", () => {
    expect(searchDetail({ pattern: "err" }, "/cwd")).toBe('"err"');
  });
});

describe("listDetail", () => {
  it("shows newest-first sorting with and without a limit", () => {
    expect(listDetail({ path: ".flywheel/log", sort: "mtime", limit: 8 }, "/cwd")).toBe(".flywheel/log | newest 8");
    expect(listDetail({ path: "src", sort: "mtime" }, "/cwd")).toBe("src | newest first");
  });

  it("omits the sort token for name order", () => {
    expect(listDetail({ path: "src", sort: "name", limit: 8 }, "/cwd")).toBe("src");
  });
});

describe("shellDetail", () => {
  it("preserves linebreaks and indentation in multiline commands", () => {
    const command = "python3 - <<'EOF'\nimport json\nif True:\n    print('hi')\nEOF";
    expect(shellDetail({ command }, "/cwd")).toBe(command);
  });

  it("shortens cwd-prefixed paths", () => {
    expect(shellDetail({ command: "cat /cwd/a.txt" }, "/cwd")).toBe("cat a.txt");
  });
});
