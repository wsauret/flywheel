import { describe, expect, it } from "bun:test";
import { buildSystemPrompt, type WorkspaceContext } from "../../src/harness/prompts.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function baseContext(): WorkspaceContext {
  return {
    os: "darwin arm64 24.0.0",
    cwd: "/Users/test/project",
    shell: "/bin/zsh",
    homeDir: "/Users/test",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// System Prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSystemPrompt", () => {
  it("includes OS and working directory", () => {
    const prompt = buildSystemPrompt(baseContext());

    expect(prompt).toContain("darwin arm64 24.0.0");
    expect(prompt).toContain("/Users/test/project");
  });

  it("includes shell info", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).toContain("/bin/zsh");
  });

  it("includes git branch when available", () => {
    const ctx = { ...baseContext(), gitBranch: "feat/awesome" };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("feat/awesome");
  });

  it("includes git status when available", () => {
    const ctx = { ...baseContext(), gitStatus: "M src/index.ts" };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("M src/index.ts");
  });

  it("omits git info when not available", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).not.toContain("Git branch:");
    expect(prompt).not.toContain("Git status:");
  });

  it("appends custom instructions when provided", () => {
    const ctx = {
      ...baseContext(),
      customInstructions: "Always use TypeScript strict mode.",
    };
    const prompt = buildSystemPrompt(ctx);

    expect(prompt).toContain("Custom Instructions");
    expect(prompt).toContain("Always use TypeScript strict mode.");
  });

  it("includes tool usage instructions", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).toContain("Tools");
    expect(prompt).toContain("task_complete");
  });

  it("includes security guidance", () => {
    const prompt = buildSystemPrompt(baseContext());
    expect(prompt).toContain("Security");
    expect(prompt).toContain("API keys");
  });

  it("includes directory listing when available", () => {
    const ctx = {
      ...baseContext(),
      directoryListing: "total 32\ndrwxr-xr-x  5 user  staff  160 Jan 1 12:00 src",
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Directory Listing");
    expect(prompt).toContain("drwxr-xr-x");
  });
});
