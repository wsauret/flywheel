import { afterAll, describe, expect, test } from "bun:test";
import { buildSystemPrompt as buildSystemPromptTiers, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { detectModelFamily } from "../../../../src/infra/llm/model-family.js";
import { ANTHROPIC_PROMPT_NOTES } from "../../../../src/orchestration/agent-runtime/llm/provider-description.js";
import { SHARED_PROMPT_NOTES } from "../../../../src/orchestration/agent-runtime/llm/prompt-notes.js";
import { testBaseTools } from "../../../helpers/request-tool-surface.js";
import { bashToolSurface, SHELL_OUTPUT_GUIDANCE } from "../../../../src/orchestration/agent-runtime/tools/bash-guidance.js";
import { GLOBAL_GUIDELINE_ID, renderGlobalGuidelines } from "../../../../src/orchestration/agent-runtime/global-guidelines.js";
import { loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { testDirectories } from "../../../helpers/directories.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptCapabilities, promptOptions } from "../../../helpers/prompt-capabilities.js";

const BASE = testBaseTools();
// The builder takes the universal prompt as an input: production loads it from
// the startup-selected overlay roots, so these tests load the same source-tree
// copy from an empty project realm.
const promptRealmRoot = mkdtempSync(join(tmpdir(), "prompt-realm-"));
afterAll(() => rmSync(promptRealmRoot, { recursive: true, force: true }));
const corePrompt = loadSystemPrompt(testDirectories(promptRealmRoot));
const buildSystemPrompt = (...args: Parameters<typeof buildSystemPromptTiers>): string =>
  renderSystemPrompt(buildSystemPromptTiers(...args));

const SUBAGENT_SPEC: ToolPromptFields = {
  name: "subagent",
  action: "task_subagent",
  description: "Delegate investigation or scoped work to specialized subagents",
  promptSnippet: "Delegate independent investigation or scoped work to specialized subagents (parallelize with multiple calls)",
  promptGuidelines: [
    "Write a thorough prompt. Think of each subagent as a productive junior engineer who cannot ask follow-ups once started — if you do not include it, they will not know it. Terse prompts produce shallow results.",
  ],
};

function toolByName(name: string): ToolPromptFields {
  if (name === "subagent") return SUBAGENT_SPEC;
  const tool = BASE.get(name);
  if (tool) return tool;
  throw new Error(`No base tool named '${name}'`);
}

function specs(...names: string[]): ToolPromptFields[] {
  return names.map(toolByName);
}

describe("detectModelFamily", () => {
  test("detects anthropic family from claude model names", () => {
    expect(detectModelFamily("claude-sonnet-4-5")).toBe("anthropic");
    expect(detectModelFamily("claude-opus-4-7")).toBe("anthropic");
    expect(detectModelFamily("claude-haiku-4-5")).toBe("anthropic");
  });

  test("detects openai family from gpt/o-series model names", () => {
    expect(detectModelFamily("gpt-4o")).toBe("openai");
    expect(detectModelFamily("gpt-4o-mini")).toBe("openai");
    expect(detectModelFamily("o3")).toBe("openai");
    expect(detectModelFamily("o1-preview")).toBe("openai");
    expect(detectModelFamily("codex-mini")).toBe("openai");
    expect(detectModelFamily("chatgpt-4o-latest")).toBe("openai");
  });

  test("detects google family from gemini model names", () => {
    expect(detectModelFamily("gemini-2.5-pro")).toBe("google");
    expect(detectModelFamily("gemma-3")).toBe("google");
  });

  test("returns null for unknown models", () => {
    expect(detectModelFamily("llama-3")).toBeNull();
  });
});

describe("buildSystemPrompt — identity and constraints", () => {
  test("contains identity text regardless of model family", () => {
    for (const style of [ANTHROPIC_PROMPT_NOTES, SHARED_PROMPT_NOTES]) {
      const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
        corePrompt,
        promptNotes: style,
        tools: [],
      }));
      expect(prompt).toContain("pragmatic software engineering agent");
    }
  });

  test("contains constraints regardless of model family", () => {
    for (const style of [ANTHROPIC_PROMPT_NOTES, SHARED_PROMPT_NOTES]) {
      const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
        corePrompt,
        promptNotes: style,
        tools: [],
      }));
      expect(prompt).toContain("Do NOT make assumptions. Prove each claim with the evidence that can settle it");
    }
  });
});

describe("buildSystemPrompt — per-tool guidance composition", () => {
  test("shell prompts preserve Flywheel's live output stream", () => {
    const expectedGuidance = "Never redirect, suppress, filter, or capture diagnostic output";
    const bashPrompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("bash"),
    }));
    expect(bashPrompt).toContain(expectedGuidance);
    expect(bashPrompt).toContain("runtime transfers a command to managed execution");
    expect(bashPrompt).toContain("stdout is the requested file artifact");
  });

  test("bash mechanics live in the tool description and schema, not the prompt", () => {
    const bash = BASE.get("bash")!;
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("bash"),
    }));
    // Output compression semantics belong to the field that controls them.
    expect(JSON.stringify(bash.inputSchema)).toContain("omission marker");
    expect(prompt).not.toContain("omission marker");
    // Agents pick shell or file tools freely, so nothing steers inspection away from the shell.
    expect(bash.description).not.toContain("Prefer read, search, and list");
    expect(prompt).not.toContain("instead of shell commands");
    // Scripting is licensed, not banned.
    expect(bash.description).toContain("scratch scripts is a normal, expected way to work");
    const mutationGuidance = "Run Git commands as separate calls without mutates. Never chain a Git command onto a mutating command. Git commands that change the repository are refused inside mutates: true; rerun them as a separate call without mutates. Read-only Git commands, including scripts and build tools that only read Git, remain allowed inside mutating commands. Set mutates: true only when the command's purpose is to change the project files you are working on, so that the change is recorded and reviewed like an edit or write tool change. Examples: heredoc and cat > writes, sed -i, Python or Bun scripts that rewrite files, formatters, code generators, and plain mv and rm. Leave it unset when the writes are side effects of running something: installing dependencies or binaries, builds, tests, caches, and servers. Write this field first, before command. Name the target tree with cwd, not an absolute cd in the command. Use relative project paths: the command runs in a private copy, and only its changes to file contents land when it exits. Processes it starts can end when it exits, so start servers and watchers in a separate call without mutates. Git objects, the index, refs, and stash changes never land from the copy. Create files to run, such as scratch scripts, with the write tool; bash only runs them.";
    for (const fileEditTool of ["edit", "apply_patch"] as const) {
      const { description } = bashToolSurface({ fileEditTool });
      const prefix = `${mutationGuidance} These mutations are recorded like changes from the ${fileEditTool} and write tools. `;
      expect(description.slice(0, prefix.length)).toBe(prefix);
      expect(description.split(mutationGuidance)).toHaveLength(2);
      expect(description).toContain("Chain dependent commands with && or ; within one call, but keep Git commands separate from mutating commands.");
    }
    expect(bashToolSurface().inputSchema.properties).toEqual(expect.objectContaining({
      mutates: { type: "boolean", description: `${mutationGuidance} Cannot be combined with persist_after_exit.` },
    }));
    expect(bash.description.startsWith(mutationGuidance)).toBe(true);
    expect(bash.description).toContain("Keep writes inside the project, the .flywheel folders, and registered worktrees");
    expect(prompt).not.toContain("glob_pattern (not find)");
    // The prompt keeps only the behavior contract the description does not state.
    expect(prompt).toContain("Preserve live command output.");
    expect(prompt).not.toContain("scratch scripts is a normal, expected way to work");
  });

  test("a headless shell offers no mutating declaration, and a guard that is off names no write roots", () => {
    const interactive = bashToolSurface();
    const headless = bashToolSurface({ mutatingDeclaration: false });
    expect(Object.keys(headless.inputSchema.properties ?? {})).toEqual(Object.keys(interactive.inputSchema.properties ?? {}).filter((field) => field !== "mutates"));
    expect(headless.description).not.toMatch(/mutat/);
    expect(headless.description).toContain("Chain dependent commands with && or ; within one call. A command that reads text typed into the terminal");
    expect(headless.description).toBe(interactive.description.slice(interactive.description.indexOf("Execute a shell command")).replace(", but keep Git commands separate from mutating commands", ""));

    const writeRoots = "Keep writes inside the project, the .flywheel folders, and registered worktrees; the shell refuses the writes elsewhere that it recognizes.";
    const unguarded = bashToolSurface({ writeGuard: false });
    expect(interactive.description).toContain(writeRoots);
    expect(unguarded.description).not.toContain(writeRoots);
    expect(unguarded.description).toBe(interactive.description.replace(` ${writeRoots}`, ""));
    expect(unguarded.inputSchema).toEqual(interactive.inputSchema);
  });

  test("a shell without background launches, persistence, or other file tools names none of them", () => {
    const interactive = bashToolSurface();
    const foreground = bashToolSurface({ background: false });
    expect(Object.keys(foreground.inputSchema.properties ?? {})).toEqual(Object.keys(interactive.inputSchema.properties ?? {}).filter((field) => field !== "background" && field !== "persist_after_exit"));
    expect(foreground.description).not.toMatch(/background|persist_after_exit/);
    expect(JSON.stringify(foreground.inputSchema)).not.toMatch(/background|persist/i);
    expect(foreground.description).toContain("Never use shell-level &, nohup, or disown.");

    // Every shell says how to stop a process; only the persist_after_exit field names the way past the runtime's exit.
    const stopById = "Stop a process by its process-tool id or its exact PID. Do not match on a process name or a command-line pattern";
    for (const surface of [interactive, foreground]) expect(surface.description).toContain(stopById);
    expect(interactive.description).toContain("A managed background command ends when its runtime exits.");
    expect(JSON.stringify(interactive.inputSchema)).toContain("Without it, runtime exit ends the command.");
    const unpersisted = bashToolSurface({ persistence: false });
    expect(Object.keys(unpersisted.inputSchema.properties ?? {})).toEqual(Object.keys(interactive.inputSchema.properties ?? {}).filter((field) => field !== "persist_after_exit"));
    expect(JSON.stringify(unpersisted.inputSchema)).not.toMatch(/persist/i);
    expect(unpersisted.description).toBe(interactive.description);

    const alone = bashToolSurface({ has: () => false });
    expect(alone.description).not.toMatch(/write tool|edit tool|search tool|edit and write/);
    expect(alone.description).toContain("recorded and reviewed like a file edit");
    expect(Object.keys(alone.inputSchema.properties ?? {})).toEqual(Object.keys(interactive.inputSchema.properties ?? {}));
    expect(JSON.stringify(alone.inputSchema)).not.toContain("write tool");
  });

  test("self-debug guidance advertises only the registered event-search command", () => {
    const prompt = buildSystemPrompt(promptOptions({ promptKind: "chat", corePrompt, tools: specs("bash"), selfDebug: true }));
    expect(prompt).toContain("flywheel events search");
    expect(prompt).toContain("Before rerunning completed background work")
    expect(prompt).toContain("inspect its completion facts for completion evidence, its handoff facts for handoffs")
    expect(prompt).not.toMatch(/subagent\.completed|handoff\.written/)
    expect(prompt).toContain("chat.entries.appended")
    expect(prompt).not.toContain("flywheel trace search");
    expect(prompt).not.toContain("events:search");
  });

  test("search guidance is content-only and lives in the description", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("search"),
    }));
    expect(prompt).toContain("- search:");
    expect(prompt).not.toContain("Use search to list paths");
    const description = BASE.get("search")!.description;
    expect(description).toContain("Search file contents");
    expect(description).toContain("glob and type constrain which files are searched");
    expect(prompt).not.toContain("glob and type constrain which files are searched");
  });

  test("list guidance lives in the description and does not steer away from the shell", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("list"),
    }));
    expect(prompt).toContain("- list:");
    const description = BASE.get("list")!.description;
    expect(description).not.toContain("in place of ls");
    expect(description).toContain("Use search for file contents.");
    expect(description).toContain("recursive path discovery");
    expect(prompt).not.toContain("ls, find, fd, or locate");
  });

  test("every kernel file tool instruction has exactly one home", () => {
    // Mechanics live in the description or the field that controls them; the
    // per-tool guideline list keeps only behavior contracts the description
    // cannot state.
    for (const name of ["read", "search", "list", "edit", "write"]) expect(BASE.get(name)!.promptGuidelines).toBeUndefined();
    expect(BASE.get("bash")!.promptGuidelines).toEqual([SHELL_OUTPUT_GUIDANCE]);
    const searchSchema = JSON.stringify(BASE.get("search")!.inputSchema);
    expect(searchSchema).toContain("recency as tiebreaker");
    expect(searchSchema).toContain("no match cap; sorted by count");
    expect(searchSchema).toContain("Cannot combine with output_mode matching_files or count");
    // A saved-output file is recovered with the tools that the agent has; with none of them the guideline is absent.
    const savedOutput = (tools: string[]) => renderGlobalGuidelines([GLOBAL_GUIDELINE_ID.savedOutputRecovery], promptCapabilities(tools.map((name) => ({ name }))));
    expect(savedOutput(["read"])[0]).toContain("names a saved-output file, read that file or search inside it for the part you need");
    expect(savedOutput(["bash"])[0]).toContain("read that file or search inside it");
    expect(savedOutput(["search"])[0]).toContain("names a saved-output file, search inside that file for the part you need");
    expect(savedOutput([])).toEqual([]);
    const marker = renderGlobalGuidelines([GLOBAL_GUIDELINE_ID.secretRedactionMarker], promptCapabilities([]))[0];
    expect(marker).toContain("recover the bytes through a transformed view of the file, such as each line reversed;");
    expect(marker).not.toContain("sed -n");
  });

  test("bash guidance is absent when bash is not loaded", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("read"),
    }));
    expect(prompt).not.toContain("raw_output");
    expect(prompt).not.toContain("2>&1");
  });

  test("includes model-family-specific communication section", () => {
    const anthropicPrompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      chatHost: { communication: true },
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: [],
    }));
    const openaiPrompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      chatHost: { communication: true },
      promptNotes: SHARED_PROMPT_NOTES,
      tools: [],
    }));
    expect(anthropicPrompt).toContain("No emojis");
    expect(openaiPrompt).toContain("No emojis");
    expect(anthropicPrompt).toContain("Keep it conversational");
    expect(openaiPrompt).toContain("Keep it conversational");
  });

  test("keeps chat communication guidance out of headless prompts", () => {
    const chat = buildSystemPrompt(promptOptions({ promptKind: "chat", chatHost: { communication: true }, corePrompt, tools: [] }));
    const headless = buildSystemPrompt(promptOptions({ promptKind: "headless", corePrompt, tools: [] }));
    const concise = "Be concise in narration";
    const evidence = "List the file paths and line numbers";

    expect(chat.split(concise)).toHaveLength(2);
    expect(chat.split(evidence)).toHaveLength(2);
    expect(headless).not.toContain(concise);
    expect(headless).not.toContain(evidence);
  });

  test("Available tools list reflects only loaded tools", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("bash", "read", "handoff"),
    }));
    expect(prompt).toContain("- bash:");
    expect(prompt).toContain("- read:");
    expect(prompt).toContain("- handoff:");
  });

  test("handoff guidance is included when tool is loaded", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("handoff"),
    }));
    expect(prompt).toContain("handoff fields directly");
  });
});


describe("buildSystemPrompt — subagent subagent", () => {
  test("includes subagent guidelines when subagent tool is loaded", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("bash", "read", "subagent"),
    }));
    expect(prompt).toContain("- subagent:");
    expect(prompt).toContain("Terse prompts produce shallow results");
  });

  test("excludes subagent guidelines when subagent tool is not loaded", () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      promptNotes: ANTHROPIC_PROMPT_NOTES,
      tools: specs("bash", "read"),
    }));
    expect(prompt).not.toContain("- subagent:");
    expect(prompt).not.toContain("Terse prompts produce shallow results");
  });
});
