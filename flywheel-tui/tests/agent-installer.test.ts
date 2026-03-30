import { describe, test, expect } from "bun:test";
import { transformForOpenCode } from "../src/agents/installer";

describe("transformForOpenCode", () => {
  test("strips name, tools, and skills from frontmatter", () => {
    const input = `---
name: locator-web
description: "Find relevant URLs"
model: haiku
tools: [WebSearch]
skills: [flywheel-conventions]
---

# Web Searcher Agent

Body content here.
`;
    const result = transformForOpenCode(input);
    expect(result).not.toContain("name:");
    expect(result).not.toContain("tools:");
    expect(result).not.toContain("skills:");
    expect(result).toContain("description:");
    expect(result).toContain("# Web Searcher Agent");
    expect(result).toContain("Body content here.");
  });

  test("adds mode: subagent", () => {
    const input = `---
name: locator-web
description: "Find URLs"
model: haiku
tools: [WebSearch]
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("mode: subagent");
  });

  test("maps haiku to full model ID", () => {
    const input = `---
name: locator-web
description: "Find URLs"
model: haiku
tools: [WebSearch]
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("model: anthropic/claude-haiku-4-5");
    expect(result).not.toMatch(/model: haiku/);
  });

  test("maps sonnet to full model ID", () => {
    const input = `---
name: reviewer-architecture
description: "Architecture review"
model: sonnet
tools: [Read, Grep, Glob, Skill]
skills: [flywheel-conventions, language-standards]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("model: anthropic/claude-sonnet-4-5");
    expect(result).not.toMatch(/model: sonnet/);
  });

  test("maps opus to full model ID", () => {
    const input = `---
name: test-agent
description: "Test"
model: opus
tools: [Read]
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("model: anthropic/claude-opus-4-6");
  });

  test("passes through unknown model names unchanged", () => {
    const input = `---
name: test-agent
description: "Test"
model: gpt-4o
tools: [Read]
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("model: gpt-4o");
  });

  test("returns content unchanged if no frontmatter", () => {
    const input = "# Just a heading\n\nNo frontmatter here.";
    const result = transformForOpenCode(input);
    expect(result).toBe(input);
  });

  test("handles multiline tools block", () => {
    const input = `---
name: test-agent
description: "Test"
model: sonnet
tools:
  - Read
  - Grep
  - Glob
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    expect(result).not.toContain("tools:");
    expect(result).not.toContain("  - Read");
    expect(result).not.toContain("  - Grep");
    expect(result).toContain("description:");
    expect(result).toContain("mode: subagent");
  });

  test("preserves body content intact", () => {
    const input = `---
name: locator-web
description: "Find URLs"
model: haiku
tools: [WebSearch]
skills: [flywheel-conventions]
---

# Web Searcher Agent

Some **markdown** content with [links](http://example.com).

- List item 1
- List item 2

\`\`\`js
const x = 1;
\`\`\`
`;
    const result = transformForOpenCode(input);
    expect(result).toContain("# Web Searcher Agent");
    expect(result).toContain("Some **markdown** content");
    expect(result).toContain("- List item 1");
    expect(result).toContain("const x = 1;");
  });

  test("produces valid frontmatter structure", () => {
    const input = `---
name: locator-web
description: "Find URLs"
model: haiku
tools: [WebSearch]
skills: [flywheel-conventions]
---

Body
`;
    const result = transformForOpenCode(input);
    // Should start with --- and have a closing ---
    expect(result.startsWith("---\n")).toBe(true);
    const fmEnd = result.indexOf("---\n", 4);
    expect(fmEnd).toBeGreaterThan(4);

    // Extract frontmatter and verify no stripped keys
    const fm = result.substring(4, fmEnd);
    const lines = fm.split("\n").filter((l) => l.trim());
    const keys = lines.map((l) => l.split(":")[0]);
    expect(keys).toContain("description");
    expect(keys).toContain("model");
    expect(keys).toContain("mode");
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("tools");
    expect(keys).not.toContain("skills");
  });
});
