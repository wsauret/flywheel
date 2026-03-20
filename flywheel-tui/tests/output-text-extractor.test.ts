import { describe, it, expect } from "bun:test";
import { extractTextFromOutput } from "../src/workflows/output-text-extractor";

describe("extractTextFromOutput", () => {
  it("extracts text from OpenCode assistant events (real format)", () => {
    const ndjson = [
      '{"type":"system","subtype":"init","session_id":"abc","tools":[],"model":"claude"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"## Open Questions\\n\\n1. Where should the utility live?\\n"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"some tool output"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Based on the findings, I recommend...\\n"}]}}',
    ].join("\n");

    const result = extractTextFromOutput(ndjson);
    expect(result).toContain("## Open Questions");
    expect(result).toContain("1. Where should the utility live?");
    expect(result).toContain("Based on the findings");
    expect(result).not.toContain("system");
    expect(result).not.toContain("tool_result");
  });

  it("extracts text from simple text events (format 2)", () => {
    const ndjson = [
      '{"type":"text","text":"## Open Questions\\n"}',
      '{"type":"text","text":"\\n1. Should we use X?\\n"}',
    ].join("\n");

    const result = extractTextFromOutput(ndjson);
    expect(result).toContain("## Open Questions");
    expect(result).toContain("1. Should we use X?");
  });

  it("skips system, user, and tool_use events", () => {
    const ndjson = [
      '{"type":"system","subtype":"init","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello\\n"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"data"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}},{"type":"text","text":"World\\n"}]}}',
    ].join("\n");

    const result = extractTextFromOutput(ndjson);
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    expect(result).not.toContain("system");
    expect(result).not.toContain("tool_result");
    expect(result).not.toContain("tool_use");
  });

  it("preserves plain text lines (non-JSON)", () => {
    const output = "Just plain text\nWith multiple lines";
    const result = extractTextFromOutput(output);
    expect(result).toContain("Just plain text");
    expect(result).toContain("With multiple lines");
  });

  it("returns empty string for empty input", () => {
    expect(extractTextFromOutput("")).toBe("");
    expect(extractTextFromOutput("   ")).toBe("");
  });

  it("handles malformed JSON gracefully (treats as plain text)", () => {
    const output = '{"type":"text", broken json\nNormal line';
    const result = extractTextFromOutput(output);
    expect(result).toContain('{"type":"text", broken json');
    expect(result).toContain("Normal line");
  });

  it("extracts text from assistant events with thinking blocks (skips thinking)", () => {
    const ndjson = [
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me analyze..."},{"type":"text","text":"## Open Questions\\n\\n1. Question one\\n"}]}}',
    ].join("\n");

    const result = extractTextFromOutput(ndjson);
    expect(result).toContain("## Open Questions");
    expect(result).toContain("1. Question one");
    expect(result).not.toContain("Let me analyze");
  });

  it("end-to-end: parses questions from realistic OpenCode assistant output", () => {
    const { parseOpenQuestions } = require("../src/workflows/question-parser");

    const ndjson = [
      '{"type":"system","subtype":"init","session_id":"test","tools":[],"model":"claude"}',
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"I need to review this plan..."}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I\'ll dispatch all reviewer agents in parallel.\\n"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"reviewer findings..."}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"# Plan Review Summary\\n\\n## Critical (P1)\\n\\n| # | Finding | File | Reviewers | Action Required |\\n|---|---------|------|-----------|-----------------|\\n| 1 | Missing auth | src/api.ts:42 | security | Add JWT |\\n\\n## Open Questions\\n\\n1. Should we use JWT tokens or session cookies?\\n2. What is the expected throughput for the auth endpoint?\\n\\n---\\n\\nRecommendation: Approve with conditions.\\n"}]}}',
    ].join("\n");

    const cleanText = extractTextFromOutput(ndjson);
    const questions = parseOpenQuestions(cleanText);

    expect(questions).toHaveLength(2);
    expect(questions[0].question).toContain("JWT tokens or session cookies");
    expect(questions[1].question).toContain("expected throughput");
  });

  it("end-to-end: parses P3 findings from realistic OpenCode assistant output", () => {
    const { parseP3Findings } = require("../src/workflows/review-output-extractor");

    const ndjson = [
      '{"type":"system","subtype":"init","session_id":"test","tools":[],"model":"claude"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"## Summary\\n\\nCode is solid.\\n\\n## Findings\\n\\n| # | Finding | Severity | File | Summary |\\n|---|---------|----------|------|---------|\\n| 1 | Bug | P1 | src/a.ts:1 | Fix crash |\\n| 2 | Style | P3 | src/b.ts:5 | Rename var |\\n\\n## Minor Findings\\n\\n- P3: Add docs at `src/c.ts:10`\\n- P3 (deferred): Rename internal var at `src/d.ts:20` -- reason: low impact\\n"}]}}',
    ].join("\n");

    const cleanText = extractTextFromOutput(ndjson);
    const findings = parseP3Findings(cleanText);

    expect(findings.length).toBeGreaterThanOrEqual(2);
    const titles = findings.map((f: { title: string }) => f.title);
    expect(titles.some((t: string) => t.includes("Style") || t.includes("Rename"))).toBe(true);
  });
});
