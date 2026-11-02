import { describe, expect, test } from "bun:test";
import { renderAgentOutput } from "../../../../src/workflows/output-contract/render.js";

const json = (value: unknown) => ["```json", JSON.stringify(value, null, 2), "```"].join("\n");

describe("renderAgentOutput", () => {
  test("renders the summary first, then contract order, then the other stored keys in stored order", () => {
    expect(renderAgentOutput({ extra: "late", b: "bee", summary: "Done.", a: "ay" }, ["a", "b", "absent"])).toBe(
      "### Summary\nDone.\n\n### A\nay\n\n### B\nbee\n\n### Extra\nlate",
    );
  });

  test("renders scalars as text, string lists as bullets, command runs as citations, and other values as JSON", () => {
    const rendered = renderAgentOutput({
      summary: "Fixed.",
      count: 3,
      passed: false,
      notes: ["first", "second"],
      none: [],
      missing: null,
      commands_run: [
        { command: "bun test", toolUseId: "toolu_1", exitCode: 0, observation: "12 tests passed" },
        { command: "bun run lint", toolUseId: "toolu_2", cwd: "/repo/web", exitCode: 1, changedAfter: [], observation: "2 errors" },
        { command: "bun run check", toolUseId: "toolu_3", cwd: "/repo", exitCode: 0, changedAfter: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"], observation: "ok" },
        { command: "git diff --stat" },
      ],
      phases: [{ id: "p1" }],
    }, []);
    expect(rendered).toBe([
      "### Summary\nFixed.",
      "### Count\n3",
      "### Passed\nfalse",
      "### Notes\n- first\n- second",
      `### None\n${json([])}`,
      `### Missing\n${json(null)}`,
      [
        "### Commands Run",
        "- `bun test` (exit 0): 12 tests passed",
        "- `bun run lint` in /repo/web (exit 1): 2 errors",
        "- `bun run check` in /repo (exit 0; files changed after this run: a.ts, b.ts, c.ts, d.ts, e.ts (+2 more)): ok",
        "- `git diff --stat`",
      ].join("\n"),
      `### Phases\n${json([{ id: "p1" }])}`,
    ].join("\n\n"));
  });

  test("renders an investigation debug handoff with its stage and null hypothesis", () => {
    const rendered = renderAgentOutput(
      { stage: "investigation", summary: "Nothing to change.", hypothesis: null, evidence: ["src/a.ts:4 already returns it."] },
      ["stage", "summary", "hypothesis", "evidence"],
    );
    expect(rendered).toBe(`### Summary\nNothing to change.\n\n### Stage\ninvestigation\n\n### Hypothesis\n${json(null)}\n\n### Evidence\n- src/a.ts:4 already returns it.`);
  });

  test("keeps a contest verdict that the current contract no longer declares", () => {
    const findings = [{ kind: "capture_mismatch", severity: "major" }];
    const rendered = renderAgentOutput({ schema_version: 1, verdict: "issues", summary: "One mismatch.", findings }, ["summary", "findings"]);
    expect(rendered).toContain("### Verdict\nissues");
    expect(rendered).toContain(`### Findings\n${json(findings)}`);
  });

  test("keeps the artifacts and steering of a stored revision 5 work handoff", () => {
    const artifacts = {
      files_modified: ["src/rows.ts"],
      commands_run: [{ command: "bun test", toolUseId: "toolu_1", exitCode: 0, observation: "3 pass" }],
    };
    const steering = [{ id: "s1", status: "applied", instruction: "Hide failed rows.", effect: "Rows stay hidden.", supersedes: ["d1"] }];
    const contract = { directives: [{ id: "d1", status: "superseded", steering_id: "s1" }] };
    const rendered = renderAgentOutput(
      { summary: "Implemented.", artifacts, verification: "Focused test passes.", user_steering: steering, contract_result: contract },
      ["summary", "artifacts", "verification", "contract_result"],
    );
    expect(rendered).toBe([
      "### Summary\nImplemented.",
      `### Artifacts\n${json(artifacts)}`,
      "### Verification\nFocused test passes.",
      `### Contract Result\n${json(contract)}`,
      `### User Steering\n${json(steering)}`,
    ].join("\n\n"));
  });

  test("keeps the empty open questions of a stored spec and the schema version of a stored surface map", () => {
    expect(renderAgentOutput({ summary: "Plan.", open_questions: [] }, ["summary"])).toContain(`### Open Questions\n${json([])}`);
    expect(renderAgentOutput({ schema_version: 1, summary: "Map.", run_dir: "docs/qa/runs/r" }, ["run_dir"]))
      .toBe("### Summary\nMap.\n\n### Run Dir\ndocs/qa/runs/r\n\n### Schema Version\n1");
  });
});
