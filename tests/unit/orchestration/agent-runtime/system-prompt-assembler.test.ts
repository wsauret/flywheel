import { afterAll, describe, it, expect } from "bun:test";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSystemPrompt as buildSystemPromptTiers,
  buildSystemPromptParts,
  firstSentence,
  renderToolContext,
  renderCommunicationBlock,
  type ToolPromptFields,
} from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt, SYSTEM_PROMPT_SEPARATOR as SEPARATOR } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { createSkillTool } from "../../../../src/orchestration/agent-runtime/tools/skill.js";
import { createBashDefinition } from "../../../../src/orchestration/agent-runtime/tools/bash.js";
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js";
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { testDirectories } from "../../../helpers/directories.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js";
import { testKernelToolDeps } from "../../../helpers/request-tool-surface.js";
import { promptCapabilities, promptOptions } from "../../../helpers/prompt-capabilities.js";

const bashDefinition = createBashDefinition();

interface UnknownRecord { [key: string]: unknown }

const agentsMd = "Always use Bun, not Node.";

function spec(name: string, opts: Partial<ToolPromptFields> = {}): ToolPromptFields {
  return { action: "ui_meta", description: `${name} tool`, ...opts, name };
}

const TOOLS: ToolPromptFields[] = [
  spec("bash", { description: "Run shell commands. Supports bash.", promptSnippet: "Execute shell commands", promptGuidelines: ["Always quote paths"], promptExamples: "bash ls -la" }),
  spec("read", { description: "Read files from disk. Requires path.", promptGuidelines: ["Use absolute paths"] }),
];

const SKILL_BODY = "# Extract\n\nOpen the PDF, then extract the text layer.\n";
const PDF_SKILL = testSkill("pdf-processing", {
  name: "PDF Processing",
  trigger: "Use when the task extracts text from PDF files.",
  body: SKILL_BODY,
});
const skillRevision: SkillRegistryRevision = testSkillRevision([PDF_SKILL]);
const CORE_SECTIONS = ["CONSTRAINTS:"];
// Engineering doctrine is its own overlayable asset, composed only for agents
// that author or judge code; the sections it owns follow the core prompt.
const DOCTRINE_SECTIONS = ["WRITING:", "ELEGANCE:"];
// The assembler takes the universal prompt as an input: production loads it
// from the startup-selected overlay roots, so these tests load the same
// source-tree copy from an empty project realm.
const promptRealmRoot = mkdtempSync(join(tmpdir(), "prompt-realm-"));
afterAll(() => rmSync(promptRealmRoot, { recursive: true, force: true }));
const promptRealm = testDirectories(promptRealmRoot);
const corePrompt = loadSystemPrompt(promptRealm);
const engineeringDoctrine = loadEngineeringDoctrine(promptRealm);
const buildSystemPrompt = (...args: Parameters<typeof buildSystemPromptTiers>): string =>
  renderSystemPrompt(buildSystemPromptTiers(...args));

// The structural-defect catalog lives in the elegance-review-principles skill,
// which every reviewer and review synthesizer composes; the always-on doctrine
// keeps the decision checklist and does not restate the catalog.
const CATALOG_MARKERS = ["ANTI-PATTERNS", "Universal Principles", "God Class", "Comments-as-Apology"];
const ELEGANCE_MARKERS = [
  "Maximize elegance",
  "read as if every decision was deliberate",
  "Decision checklist",
  "Symptoms vs. root cause",
];
// Dispatch-sizing doctrine: it reaches the runners that dispatch (chat, step
// workers) and stays out of subagent prompts, because a dispatched child
// executes one already-sized assignment.
const PROPORTIONALITY_MARKERS = [
  "Orchestration must pay for itself",
  "Named triggers, not doubt",
  "Correctness gates never shrink",
  "Size honestly",
];
// Role-specific doctrine that stays with its owning step or persona.
const ROLE_SPECIFIC_REMAINDER = ["Spec Quality Bar", "Documentarian mode", "False-Positive Suppression", "OPEN QUESTION:", "Enumerative Explorer Fanout", "Lead with the Failure"];

describe("buildSystemPrompt -- chat", () => {
  const build = (overrides: UnknownRecord = {}) =>
    buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat", chatHost: { communication: true }, ...overrides }));

  it("contains core system prompt sections, tools, communication, and guidelines", () => {
    const result = build();
    for (const section of CORE_SECTIONS) expect(result).toContain(section);
    expect(result).not.toContain("PROPORTIONALITY:");
    expect(result).toContain("Available tools:");
    expect(result).toContain("COMMUNICATION:");
    expect(result).toContain("Guidelines:");
  });

  // The failure guidance is one judgment sentence in CONSTRAINTS; a numbered
  // retry recipe would be an itinerary the model does not need.
  it("states failure handling as judgment, not a numbered retry recipe", () => {
    const result = build();
    expect(result).toContain("one failure is not a reason to drop an approach that can still work");
    expect(result).not.toContain("ERROR PROTOCOL:");
    expect(result).not.toContain("3 strikes");
  });

  it("includes agentsMd under the AGENTS.md Instructions header", () => {
    expect(build({ agentsMd })).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
  });

  it("renders the scratchpad section only when scratchDir is supplied and the agent can write files", () => {
    const withScratch = build({
      scratchDir: "/proj/.flywheel/sessions/s1/scratch",
      checkpointAvailable: true,
    });
    expect(withScratch).toContain("# Scratchpad Directory");
    expect(withScratch).toContain("`/proj/.flywheel/sessions/s1/scratch`");
    expect(withScratch).toContain("All scratch is disposable");
    expect(withScratch).toContain("Keep working context in the scoped checkpoint");

    expect(build()).not.toContain("# Scratchpad Directory");

    const noBash = build({ scratchDir: "/proj/.flywheel/sessions/s1/scratch", tools: TOOLS.filter((t) => t.name !== "bash") });
    expect(noBash).not.toContain("# Scratchpad Directory");

    // The exec registration serves the same shell, so it earns the same section.
    const execOnly = build({ scratchDir: "/proj/.flywheel/sessions/s1/scratch", tools: [spec("exec"), ...TOOLS.filter((t) => t.name !== "bash")] });
    expect(execOnly).toContain("# Scratchpad Directory");

    // A file writer without a shell still needs the path: a `submit: file`
    // output is accepted only inside this directory.
    const fileTools = [spec("read", { action: "file_read" }), spec("write", { action: "file_write" }), spec("edit", { action: "file_edit" }), spec("handoff")];
    const writerOnly = build({ scratchDir: "/proj/.flywheel/sessions/s1/scratch", tools: fileTools });
    expect(writerOnly).toContain("# Scratchpad Directory");
    expect(writerOnly).toContain("`/proj/.flywheel/sessions/s1/scratch`");
  });

  it("shows notes-writing guidance only when dedicated note tools are available", () => {
    const checkpointAvailable = true;
    const noteTools = ["checkpoint_read", "checkpoint_replace", "checkpoint_decide"].map((name) => spec(name, { action: "ui_meta" }));
    const fileWriter = build({ checkpointAvailable, tools: noteTools });
    expect(fileWriter).toContain("For tasks that may span context windows");
    expect(fileWriter).toContain("checkpoint_replace");
    expect(fileWriter).not.toContain("# Scratchpad Directory");

    const readOnly = build({ checkpointAvailable, tools: [spec("read", { action: "file_read" })] });
    expect(readOnly).not.toContain("For tasks that may span context windows");
    for (const missing of noteTools) expect(build({ checkpointAvailable, tools: noteTools.filter((tool) => tool !== missing) })).not.toContain("For tasks that may span context windows");
  });

  it("requires the canonical review skill for every nontrivial completed code change", () => {
    const tools = [...TOOLS, spec("skill", { description: "Load a skill package." }), spec("subagent"), spec("workflow")];
    const result = build({ tools, skills: ["code-review"] });

    expect(result).toContain("CHAT CHANGE REVIEW:");
    expect(result).toContain('load the `code-review` skill with the `skill` tool');
    expect(result).toContain("your own edits or a delegated result, whether");
    expect(result).toContain("an objection to the structure starts a reshape.");
    expect(build({ tools, skills: ["code-review", "design"] })).toContain("starts a reshape, as the `design` skill states.");
    expect(result).toContain("The skill scales its reviewer set");
    expect(result).toContain("fix valid findings, and verify with the narrowest check");
    // The first-draft revision rule has one home: this block.
    expect(result.match(/realign what missed it/g)).toHaveLength(1);
    expect(result).toContain("Read its recorded deviations yourself: a workflow handoff carries them in its declared output, a subagent completion in its summary.");
    expect(build({ tools: [...TOOLS, spec("subagent")] })).toContain("Read its recorded deviations yourself: a subagent completion carries them in its summary.");
    expect(build({ tools: [...TOOLS, spec("workflow")] })).toContain("Read its recorded deviations yourself: a workflow handoff carries them in its declared output.");
    // A chat that can delegate nothing reads no delegation wording, and keeps the first-draft rule for its own edits.
    const alone = build();
    expect(alone).toContain("Every completed code change is a first draft, never a completion. Its intent is the approved design");
    for (const delegation of ["workflow", "subagent", "delegated result"]) expect(alone).not.toContain(delegation);
    expect(result).not.toContain("single source of truth");
    expect(result).not.toContain("Always include reviewer-elegance");
    expect(result).not.toContain("reviewer-architecture");
  });

  it("keeps the first-draft rule but names no review skill unless both review inputs are available", () => {
    const tools = [...TOOLS, spec("skill", { description: "Load a skill package." })];
    for (const result of [build({ skills: ["code-review"] }), build({ tools })]) {
      expect(result).toContain("CHAT CHANGE REVIEW:");
      expect(result).toContain("review the draft yourself");
      expect(result).not.toContain("load the `code-review` skill");
    }
  });

  it("takes communication guidance only from a typed chat-host contribution", () => {
    const concise = "Be concise in narration";
    const evidence = "List the file paths and line numbers";
    const chat = build();
    expect(chat.split(concise)).toHaveLength(2);
    expect(chat.split(evidence)).toHaveLength(2);

    const titleOrReview = build({ chatHost: undefined });
    expect(titleOrReview).not.toContain(concise);
    expect(titleOrReview).not.toContain(evidence);
  });
});

describe("buildSystemPrompt -- memory snapshot", () => {
  async function learningPrompt(writable: boolean): Promise<string> {
    const contribution = composeFirstPartyModules().contributions.find((entry) => entry.domain === "promptFragments" && entry.id === "learning-memory");
    if (!contribution || contribution.domain !== "promptFragments") throw new Error("Learning prompt contribution is missing");
    const memoryTool: RuntimeTool = { name: "memory", action: "ui_meta", description: "memory", inputSchema: { type: "object", properties: {} }, isConcurrencySafe: true, execute: async () => ({ content: "", outcome: "ok" }) };
    const tools = new Map(writable ? [["memory", memoryTool]] : []);
    const rendered = await contribution.value.render({ kernel: testKernelToolDeps(), modules: NO_MODULE_RUNTIMES, tools, memorySnapshot: snapshot, capabilities: promptCapabilities([...tools.values()]) });
    if (rendered === undefined) throw new Error("Learning prompt rendered nothing for a snapshot");
    return rendered;
  }
  const snapshot = "PROJECT MEMORY (user preferences and working context for this project) [reach: project | sha256:abc123 | 10% - 20/200 chars]\nUses bun everywhere.";

  it("renders the frozen snapshot for chat and step workers", async () => {
    const chat = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat", moduleFragments: [await learningPrompt(false)] }));
    const worker = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "workflow-agent", moduleFragments: [await learningPrompt(false)] }));

    for (const prompt of [chat, worker]) {
      expect(prompt).toContain("# Durable Memory");
      expect(prompt).toContain("Uses bun everywhere.");
      expect(prompt).toContain("This snapshot is read-only.");
      expect(prompt).toContain("selective profile");
      expect(prompt).toContain("not session notes");
      expect(prompt).toContain("AGENTS.md or its existing authority, not memory");
      expect(prompt).toContain("Entries labeled [protected] are user-owned");
      expect(prompt).toContain("Never use memory or any other tool to change their content");
    }
  });

  it("permits updates only when the memory mutation tool is present", async () => {
    const prompt = buildSystemPrompt(promptOptions({
      promptKind: "chat",
      corePrompt,
      tools: [...TOOLS, spec("memory")],
      envBlock: undefined,
      moduleFragments: [await learningPrompt(true)],
    }));

    expect(prompt).toContain("memory tool writes are durable at once and appear here in a later snapshot");
    expect(prompt).toContain("Saving nothing is often correct");
    expect(prompt).not.toContain("This snapshot is read-only.");
  });

  it("names the two reaches and carries each block's identity into the audited part", async () => {
    const part = buildSystemPromptParts(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat", moduleFragments: [await learningPrompt(false)] }))
      .find((candidate) => candidate.label === "module fragment");

    expect(part?.text).toContain("Project reach applies to this project only");
    expect(part?.text).toContain("global reach");
    expect(part?.text).toContain("reach: project | sha256:abc123");
  });

  it("renders any snapshot supplied by its host without inferring policy from prompt kind", async () => {
    const prompt = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "subagent", moduleFragments: [await learningPrompt(false)] }));
    expect(prompt).toContain("Durable Memory");
    expect(prompt).toContain("Uses bun everywhere.");
  });

  it("adds no block when there is no snapshot", () => {
    const prompt = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));
    expect(prompt).not.toContain("Durable Memory");
  });
});

describe("buildSystemPrompt -- subagent", () => {
  const build = (overrides: UnknownRecord = {}) =>
    buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "subagent", ...overrides }));

  it("does NOT contain the communication block or chat review guidance", () => {
    const result = build({ agentsMd });
    expect(result).not.toContain("COMMUNICATION:");
    expect(result).not.toContain("CHAT CHANGE REVIEW:");
  });

  it("includes agentsMd under the AGENTS.md Instructions header", () => {
    expect(build({ agentsMd })).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
    expect(build({ agentsMd })).toContain("AGENTS.md files in directories that the sections above do not name are not loaded: read the one that governs a directory before you change files in it.");
    expect(build()).not.toContain("# AGENTS.md Instructions");
  });

  it("without a loaded chain, tells an agent that can change files to read the governing AGENTS.md, and tells a read-only agent nothing", () => {
    const notLoaded = "No AGENTS.md files are loaded for your working directory. An AGENTS.md file in a directory below it is not loaded: read the one that governs a directory before you change files in it.";
    expect(build()).toContain(notLoaded);
    expect(build({ tools: [spec("read", { description: "Read files from disk." })] })).not.toContain(notLoaded);
  });

  it("contains examples when tools have them", () => {
    const result = build();
    expect(result).toContain("# Examples");
  });

});

describe("buildSystemPrompt -- elegance and proportionality doctrine", () => {
  const KINDS = ["chat", "workflow-agent", "subagent", "headless"] as const;

  for (const promptKind of KINDS) {
    const compile = (tools: ToolPromptFields[]) => buildSystemPrompt(promptOptions({
      corePrompt,
      engineeringDoctrine,
      tools,
      envBlock: undefined,
      promptKind,
    }));

    it(`${promptKind} carries the elegance doctrine`, () => {
      for (const marker of ELEGANCE_MARKERS) expect(compile(TOOLS)).toContain(marker);
    });

    it(`${promptKind} omits the doctrine when the runner opted out`, () => {
      const withoutDoctrine = buildSystemPrompt(promptOptions({
        corePrompt,
          tools: TOOLS,
        envBlock: undefined,
        promptKind,
      }));
      for (const section of DOCTRINE_SECTIONS) expect(withoutDoctrine).not.toContain(section);
      for (const marker of ELEGANCE_MARKERS) expect(withoutDoctrine).not.toContain(marker);
    });

    it(`${promptKind} gates proportionality on the actual dispatch tool surface`, () => {
      for (const marker of PROPORTIONALITY_MARKERS) {
        expect(compile(TOOLS)).not.toContain(marker);
        expect(compile([...TOOLS, spec("subagent")])).toContain(marker);
        expect(compile([...TOOLS, spec("workflow")])).toContain(marker);
      }
    });

    it(`${promptKind} leaves the structural-defect catalog to the elegance review skill`, () => {
      for (const marker of CATALOG_MARKERS) expect(compile(TOOLS)).not.toContain(marker);
    });

    it(`${promptKind} carries all seven decision checklist entries`, () => {
      for (const entry of ["| 1 |", "| 2 |", "| 3 |", "| 4 |", "| 5 |", "| 6 |", "| 7 |"]) expect(compile(TOOLS)).toContain(entry);
    });

    it(`${promptKind} omits role-specific doctrine that belongs to its owning step`, () => {
      for (const remainder of ROLE_SPECIFIC_REMAINDER) expect(compile(TOOLS)).not.toContain(remainder);
    });
  }
});

describe("buildSystemPrompt -- cross-cutting", () => {
  it("undefined optional blocks produce no empty separators", () => {
    const result = buildSystemPrompt(promptOptions({ corePrompt, tools: [], envBlock: undefined, promptKind: "chat" }));
    expect(result).not.toContain(SEPARATOR + SEPARATOR);
    expect(result).not.toMatch(/---\s*$/);
  });

  it("section separator appears between known sections", () => {
    const result = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));
    const between = result.slice(result.indexOf("CONSTRAINTS:"), result.indexOf("Available tools:"));
    expect(between).toContain("---");
  });

  it("buildSystemPrompt is deterministic -- same inputs produce identical output", () => {
    const opts = { corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "workflow-agent" as const, agentsMd };
    expect(buildSystemPrompt(promptOptions(opts))).toBe(buildSystemPrompt(promptOptions(opts)));
  });
});

describe("firstSentence", () => {
  it("extracts text up to the first period-space boundary", () => {
    expect(firstSentence("Run shell commands. Supports bash and zsh.")).toBe("Run shell commands");
  });
  it("trims leading whitespace then finds the first sentence boundary", () => {
    expect(firstSentence("  \n Run shell commands. Supports bash.")).toBe("Run shell commands");
  });
  it("returns trimmed text when input is only whitespace plus a sentenceless string", () => {
    expect(firstSentence("  no period here  ")).toBe("no period here");
  });
  it("returns empty string when period-space is at position 0", () => {
    expect(firstSentence(". rest of text")).toBe("");
  });
});

describe("renderToolContext", () => {
  it("produces Available tools, Guidelines, and Examples in one block", () => {
    const result = renderToolContext(
      [
        spec("bash", { description: "Run shell commands. Supports bash.", promptGuidelines: ["Always quote paths"], promptExamples: "bash ls -la" }),
        spec("read", { description: "Read files from disk. Requires path.", promptSnippet: "Read files from disk" }),
      ],
      ["Be concise in your responses."],
    );
    expect(result).toContain("Available tools:");
    expect(result).toContain("- bash: Run shell commands");
    expect(result).toContain("- read: Read files from disk");
    expect(result).toContain("Guidelines:");
    expect(result).toContain("- Always quote paths");
    expect(result).toContain("- Be concise in your responses.");
    expect(result).toContain("# Examples");
    expect(result).toContain("## bash");
    expect(result).toContain("bash ls -la");
  });

  it("uses promptSnippet when present, firstSentence fallback when absent", () => {
    const result = renderToolContext(
      [
        spec("bash", { description: "Run shell commands. Long desc.", promptSnippet: "Execute shell" }),
        spec("custom_read", { description: "Read files from disk. Requires path." }),
      ],
      [],
    );
    expect(result).toContain("- bash: Execute shell");
    expect(result).toContain("- custom_read: Read files from disk");
  });

  it("returns undefined for empty tools array", () => {
    expect(renderToolContext([], [])).toBeUndefined();
  });

  it("appends footer after tool listing", () => {
    const footer = "Custom tools may be added.";
    const result = renderToolContext([spec("bash", { description: "Run shell commands." })], [], footer);
    expect(result).toContain(footer);
  });

  it("deduplicates identical guidelines", () => {
    const result = renderToolContext(
      [
        spec("bash", { description: "x", promptGuidelines: ["Be concise."] }),
        spec("read", { description: "y", promptGuidelines: ["Be concise."] }),
      ],
      ["Be concise."],
    );
    expect(result!.match(/Be concise\./g)).toHaveLength(1);
  });

  it("omits Guidelines section when none exist", () => {
    const result = renderToolContext([spec("custom", { description: "Run shell." })], []);
    expect(result).toContain("Available tools:");
    expect(result).not.toContain("Guidelines:");
  });

  it("omits Examples section when no tool has examples", () => {
    const result = renderToolContext([spec("custom", { description: "Run shell." })], []);
    expect(result).not.toContain("# Examples");
  });

  it("omits tools without examples from Examples section", () => {
    const result = renderToolContext(
      [
        spec("bash", { description: "x", promptExamples: "bash ls" }),
        spec("read", { description: "y" }),
      ],
      [],
    );
    expect(result).toContain("## bash");
    expect(result).not.toContain("## read");
  });
});

describe("cross-tool batching guideline", () => {
  // The canonical batching nudge lives once in DEFAULT_GUIDELINES (injected by
  // buildSystemPrompt) and must survive the Set dedup without per-tool copies.
  const BATCHING = "Independent tool calls in one turn run concurrently and return together";

  it("buildSystemPrompt injects the canonical batching guideline exactly once", () => {
    const result = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));
    expect(result.split(BATCHING).length - 1).toBe(1);
  });

  it("instructs grouping independent calls but serializing read-before-edit dependencies, consistent with purposeful tool use", () => {
    const result = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat", chatHost: { communication: true } }));
    expect(result).toContain("reading a file before editing it");
    expect(result).toContain("Calls are independent only when none of them can change state that another one reads.");
    expect(result).toContain("a client that opens and rewrites the database another call examines");
    expect(result).toContain("not making unnecessary ones");
    expect(result).toContain("batch independent calls with distinct inputs");
    expect(result).toContain("remove duplicate calls with the same tool name and arguments");
    expect(result).toContain("Repeat a call only when a failure, changed state, or verification requirement makes a fresh result necessary");
    expect(result).toContain("A turn carries both text and tool calls");
    expect(result).toContain("Use tools purposefully. Do not call a tool unless the task requires it.");
  });

});

describe("secret redaction marker guideline", () => {
  // The mask reaches the model's own context, so the default guideline set
  // (which every caller uses today) must explain that the marker is a
  // redaction, not the true bytes of a command or file.
  const MARKER_GUIDANCE = "usually marks a runtime redaction, not the true bytes";

  it("buildSystemPrompt injects the redaction-marker guidance exactly once", () => {
    const result = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));
    expect(result.split(MARKER_GUIDANCE).length - 1).toBe(1);
    expect(result).toContain("Never copy");
  });
});

describe("global guideline selection", () => {
  it("maps a selected canonical list while retaining tool-owned guidance and examples", () => {
    const result = buildSystemPrompt(promptOptions({
      corePrompt,
      tools: TOOLS,
      envBlock: undefined,
      promptKind: "headless",
      globalGuidelineIds: ["batch-independent-tool-calls"],
    }));

    expect(result).toContain("Independent tool calls in one turn run concurrently");
    expect(result).not.toContain("saved-output file");
    expect(result).not.toContain("Be concise in narration");
    expect(result).not.toContain("List the file paths and line numbers");
    expect(result).toContain("Always quote paths");
    expect(result).toContain("# Examples");
  });

  it("keeps proportionality tied to request tools when a native guideline list is selected", () => {
    const result = buildSystemPrompt(promptOptions({
      corePrompt,
      tools: [...TOOLS, spec("subagent")],
      envBlock: undefined,
      promptKind: "headless",
      globalGuidelineIds: ["secret-redaction-marker"],
    }));

    expect(result).toContain("PROPORTIONALITY:");
  });
});

describe("renderCommunicationBlock", () => {
  it("produces the voice paragraph, core rules, and client-neutral Markdown mechanics", () => {
    const result = renderCommunicationBlock({ progress: "Send short updates.", modelNotes: "" }, promptCapabilities([]));
    expect(result).toContain("COMMUNICATION:");
    expect(result).toContain("Core rules:");
    expect(result).toContain("Markdown mechanics:");
    expect(result).not.toContain("TUI");
    expect(result).toContain("Send short updates.");
    expect(result).toContain("ASD-STE100 Simplified Technical English");
    expect(result).toContain("architecture, debugging, reviews");
    expect(result).toContain("Keep it conversational");
    expect(result).toContain("Open a run of tool work with one sentence that names the next step");
    expect(result).toMatch(/1\. Never ignore a user message\..*Never continue the work without acknowledging a user message\..*revises it with `message_session`, or ends it with Stop[\s\S]*Never end a turn by announcing work that you can start now: start it in the same turn\./);
    expect(result).toContain("what broke, what it means for the task");
    expect(result).toContain("Ordinary human warmth is welcome when it makes the work clearer; simulated emotion, personal attachment, inner life, or companionship is not");
    expect(result.split("Be concise in narration")).toHaveLength(2);
    expect(result.split("List the file paths and line numbers")).toHaveLength(2);
  });

  it("discusses in prose and confirms through ask_user when the decision UI is available", () => {
    const result = renderCommunicationBlock({ progress: "", modelNotes: "" }, promptCapabilities([{ name: "ask_user" }]));

    expect(result).toContain("Use `ask_user` only after the discussion has settled");
    expect(result).not.toContain("so that the user can reply with a single number");
  });

  it("points a challenge to the design skill only while that skill can load", () => {
    const withDesign = renderCommunicationBlock({ progress: "", modelNotes: "" }, promptCapabilities([{ name: "skill" }], ["design"]));
    const without = renderCommunicationBlock({ progress: "", modelNotes: "" }, promptCapabilities([]));
    expect(withDesign).toContain("apply the Challenge method of the `design` skill: restate their model");
    expect(without).toContain("proposes a simpler model, restate their model");
    expect(without).not.toContain("`design` skill");
  });

  it("renders shared and provider model notes in one section", () => {
    const result = renderCommunicationBlock({ progress: "Send updates.", modelNotes: "- Extra note for this model." }, promptCapabilities([]));
    expect(result.match(/MODEL NOTES:/g)).toHaveLength(1);
    expect(result).toContain("- Use tools purposefully. Do not call a tool unless the task requires it.");
    expect(result).toContain("- Extra note for this model.");
  });
});

// ── Regression: section inventory ──


function assertSectionInventory(compiled: string, expectedSections: string[]): void {
  it("contains every section once and in composition order", () => {
    for (const section of expectedSections) expect(compiled.split(section).length - 1).toBe(1);
    const indices = expectedSections.map((section) => compiled.indexOf(section));
    for (let index = 1; index < indices.length; index++) expect(indices[index]).toBeGreaterThan(indices[index - 1]!);
  });
}

describe("regression -- subagent section inventory", () => {
  const compiled = buildSystemPrompt(promptOptions({ corePrompt, engineeringDoctrine, tools: TOOLS, envBlock: undefined, promptKind: "subagent" }));
  assertSectionInventory(compiled, [...CORE_SECTIONS, ...DOCTRINE_SECTIONS, "Available tools:", "Guidelines:"]);

  it("does NOT contain sections reserved for step-agent/chat", () => {
    expect(compiled).not.toContain("COMMUNICATION:");
    expect(compiled).not.toContain("PROPORTIONALITY:");
  });
});

describe("regression -- step-agent section inventory", () => {
  const compiled = buildSystemPrompt(promptOptions({ corePrompt, engineeringDoctrine, tools: TOOLS, envBlock: undefined, promptKind: "workflow-agent", agentsMd: "Always use Bun, not Node." }));
  assertSectionInventory(compiled, [
    ...CORE_SECTIONS, ...DOCTRINE_SECTIONS, "Available tools:", "Guidelines:", "# Examples", "# AGENTS.md Instructions",
  ]);

  it("does NOT contain communication sections reserved for chat", () => {
    expect(compiled).not.toContain("COMMUNICATION:");
  });
});

describe("skill guidance gating", () => {
  const skillTool = createSkillTool({
    treeCapabilities: () => true,
    availability: { skills: new Map(), availablePersonas: new Map() },
    revision: skillRevision,
  });

  it("advertises the roster and the scan-then-load rule only when the skill tool is exposed", () => {
    const withSkill = buildSystemPrompt(promptOptions({ corePrompt, tools: [...TOOLS, skillTool], envBlock: undefined, promptKind: "chat" }));
    const withoutSkill = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));

    expect(withSkill).toContain("Installed skills");
    expect(withSkill).toContain("pdf-processing");
    expect(withSkill).toContain('action:"load"');
    // The prompt advertises triggers only; a body is loaded, never advertised.
    expect(withSkill).not.toContain(SKILL_BODY);
    expect(withoutSkill).not.toContain("Installed skills");
    expect(withoutSkill).not.toContain('action:"load"');
  });

  it("teaches the skill actions without the legacy list and page controls", () => {
    const withSkill = buildSystemPrompt(promptOptions({ corePrompt, tools: [...TOOLS, skillTool], envBlock: undefined, promptKind: "chat" }));
    const skillLines = withSkill.split("\n").filter((line) => line.includes('action:"load"'));

    expect(skillLines.length).toBeGreaterThan(0);
    for (const line of skillLines) {
      expect(line).not.toContain("page");
      expect(line).not.toContain('action:"list"');
    }
  });
});

// The always-on prompt is the kernel: universal safety, evidence, and tool
// discipline. Task method is loaded from a package, so no package body may be
// baked in for every runner regardless of the work.
describe("always-on kernel carries no package body", () => {
  const compiled = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "chat" }));

  it("leaves method owned by a package out of it", () => {
    for (const migrated of [
      "The best change is the smallest correct change",
      "Keep single-use logic inline",
      "Understand call sites before modifying interfaces",
      "IDENTIFY",
      "Banned before verification",
      "The loop",
    ]) {
      expect(compiled).not.toContain(migrated);
    }
  });
});

// Explicit background execution is the one capability-owned half of Bash.
// Its text is the same for every agent; execution refuses it where it is off.
describe("bash background-execution guidance", () => {
  const guidelinesOf = (tool: ToolPromptFields) => renderToolContext([tool], []) ?? "";

  it("advertises completion-first foreground and explicit background execution on the shipped definition", () => {
    const rendered = guidelinesOf(bashDefinition);

    const description = bashDefinition.description;
    expect(description).toContain("Set background: true");
    expect(description).toContain("A finite foreground command remains in its call until it completes, you select Detach, or it reaches the runtime cap. Detach or the cap moves it to managed execution; wait for it with the process tool.");
    expect(description).toContain("wait on any managed background command, whether launched with background=true or transferred from the foreground");
    // Timeout rules have one home: the timeout field.
    expect(JSON.stringify(bashDefinition.inputSchema)).toContain("Timeouts are entirely optional and should be used sparingly. They apply equally to foreground and managed background commands.");
    expect(description).not.toContain("Timeouts are entirely optional");
    expect(description + rendered).not.toMatch(/10 seconds|30 seconds|no output/);
    // The prompt states the mechanics nowhere a second time.
    expect(rendered).not.toContain("background: true");
    expect(rendered).toContain("Preserve live command output.");
  });

  // No person reads an unattended chat (PI-AGENT-121): it has nobody to run a prompt, a browser login, or Detach.
  it("leaves out the person's commands, Detach, and the Windows rule off Windows in an unattended chat", () => {
    const PERSON_TEXT = ["belongs to the person", "tell the person to complete it in the browser", "you select Detach"];
    const WINDOWS = "On Windows, search file contents with the search tool";
    const unattended = (platform: NodeJS.Platform) => createBashDefinition({ platform, mutatingDeclaration: false, advertised: { unattendedChat: true } }).description;
    for (const text of [...PERSON_TEXT, WINDOWS]) expect(createBashDefinition({ platform: "linux" }).description).toContain(text);
    for (const text of [...PERSON_TEXT, WINDOWS]) expect(unattended("linux")).not.toContain(text);
    expect(unattended("win32")).toContain(WINDOWS);
    // An unattended agent still learns that the runtime cap moves a long foreground command to managed execution.
    expect(unattended("linux")).toContain("A finite foreground command remains in its call until it completes or reaches the runtime cap. At the cap it moves to managed execution; wait for it with the process tool.");
    expect(unattended("linux")).not.toContain("Detach");
    // The surviving sentences are unchanged.
    for (const text of ["Chain dependent commands with && or ; within one call. Set background: true only", "Stop a process by its process-tool id or its exact PID", "stop after 30s of processing time"]) expect(unattended("linux")).toContain(text);
  });
});

describe("buildSystemPrompt -- session identity", () => {
  const messageTools = [...TOOLS, spec("message_session"), spec("list_sessions")];
  const child = { sessionId: "child-1", rootSessionId: "root-1", conversationId: "child-conversation", kind: "subagent" as const, parent: { sessionId: "root-1", name: "Fix the parser" } };
  const root = { sessionId: "root-1", rootSessionId: "root-1", conversationId: "root-conversation", kind: "chat" as const };
  const identitySection = (identity: typeof child | typeof root) => buildSystemPromptParts(promptOptions({
    corePrompt, tools: messageTools, promptKind: "chat", sessionIdentity: identity,
  })).find((part) => part.label === "session identity");

  it("states the id, the kind, and the parent of a child, and is the same in every request", () => {
    const first = identitySection(child);
    expect(first?.tier).toBe("session");
    expect(first?.text).toContain('You are session child-1, a subagent. Your parent is session root-1 ("Fix the parser").');
    expect(identitySection(child)).toEqual(first);
    expect(identitySection(root)?.text).toContain("You are session root-1, a root chat.");
    // list_sessions leaves out a session's own children, so both texts say
    // where they are.
    for (const identity of [child, root]) expect(identitySection(identity)?.text).toContain("list_sessions shows targets that you did not start. Your own children are in process(action='list').");
  });

  it("sends a child to its parent wherever an instruction says to ask the user, has a root answer a waiting child first, and tells only a root how to treat other root chats", () => {
    const text = identitySection(child)?.text ?? "";
    expect(text).toContain("message your parent with wait true");
    expect(text).toContain("Where any instruction tells you to ask the user or the person, message your parent instead.");
    expect(identitySection(root)?.text).toContain("Reply to the exact session that asked you before you end your turn. If you need the person first, ask the person, then reply to that session.");
    expect(identitySection(root)?.text).toContain("A completion notice ends the open questions of the session that it reports.");
    for (const [identity, toldAboutRootChats] of [[root, true], [child, false]] as const) expect(identitySection(identity)?.text.includes("another root chat")).toBe(toldAboutRootChats);
  });

  it("names no module tool, and renders only while list_sessions is planned", () => {
    // "subagent" and "workflow" also name session kinds, which the section states.
    // A quoted argument value, such as the `'list'` of process(action='list'),
    // names an action of a kernel tool, not the module tool of the same name.
    const sessionKinds = new Set(["subagent", "workflow"]);
    const moduleTools = composeFirstPartyModules().contributions.flatMap((entry) => entry.domain === "tools" && !sessionKinds.has(entry.id) ? [entry.id] : []);
    expect(moduleTools).toContain("ask_user");
    for (const identity of [child, root]) {
      const text = identitySection(identity)?.text ?? "";
      for (const name of moduleTools) expect(text).not.toMatch(new RegExp(`(?<![\\w'])${name}(?![\\w'])`));
    }
    expect(buildSystemPromptParts(promptOptions({ corePrompt, tools: TOOLS, promptKind: "chat", sessionIdentity: root })).some((part) => part.label === "session identity")).toBe(false);
    // An unattended chat that starts children messages them but lists no session around it.
    expect(buildSystemPromptParts(promptOptions({ corePrompt, tools: [...TOOLS, spec("message_session")], promptKind: "headless", sessionIdentity: root })).some((part) => part.label === "session identity")).toBe(false);
  });
});
