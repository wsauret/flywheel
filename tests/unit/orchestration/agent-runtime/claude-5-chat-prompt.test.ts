import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPrompt as buildSystemPromptTiers, type BuildSystemPromptOptions, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { testDirectories } from "../../../helpers/directories.js";
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

const spec = (name: string, opts: Partial<ToolPromptFields> = {}): ToolPromptFields => ({ action: "ui_meta", description: `${name} tool`, ...opts, name });
const TOOLS: ToolPromptFields[] = [spec("bash"), spec("read")];
const CORE_SECTIONS = ["CONSTRAINTS:"];
const DOCTRINE_SECTIONS = ["WRITING:", "ELEGANCE:"];
const agentsMd = "Always use Bun, not Node.";
const promptRealmRoot = mkdtempSync(join(tmpdir(), "claude-5-prompt-realm-"));
afterAll(() => rmSync(promptRealmRoot, { recursive: true, force: true }));
const promptRealm = testDirectories(promptRealmRoot);
const corePrompt = loadSystemPrompt(promptRealm);
const engineeringDoctrine = loadEngineeringDoctrine(promptRealm);
const buildSystemPrompt = (options: BuildSystemPromptOptions): string => renderSystemPrompt(buildSystemPromptTiers(options));
const build = (overrides: Partial<Parameters<typeof promptOptions>[0]> = {}): string =>
  buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "chat", chatHost: { communication: true }, ...overrides }));

/** The Claude 5 chat body is the tuned interactive prompt that replaces the general chat blocks. */
describe("Claude 5 chat body", () => {
  it("replaces the general chat blocks with the tuned Claude 5 body and keeps every other part", () => {
    const tools = [...TOOLS, spec("skill"), spec("ask_user"), spec("subagent"), spec("edit", { action: "file_edit" })];
    const general = build({ tools, engineeringDoctrine, agentsMd, skills: ["code-review"] });
    const tuned = build({ tools, engineeringDoctrine, agentsMd, skills: ["code-review"], chatPrompt: "opus-5.5" });

    expect(tuned).toStartWith("You are Flywheel's chat agent.");
    for (const kept of DOCTRINE_SECTIONS) expect(tuned).toContain(kept);
    for (const replaced of [...CORE_SECTIONS, "PROPORTIONALITY:", "CONVERSATION-FIRST DELIVERY:", "CHAT CHANGE REVIEW:", "COMMUNICATION:"]) {
      expect(general).toContain(replaced);
      expect(tuned).not.toContain(replaced);
    }
    for (const commitment of ["**Chat leads a change through delivery.**", "load the `code-review` skill", "the skill alone sizes the review to the change", "**Orchestration pays for itself.**", "**User messages come first.**", "**One coherent change at a time.**", "no change is needed is a successful result", "Understand the code before you change it", "Do only what the request needs, and still finish it", "Never test a copy of production code", "Never recommend that the user accept a narrowed draft", "rests on a spike that tested it", "end your reply with three things", "and what that proof does not cover", "A pull request description gives the same three things", "Do not stop before publication to ask for a shape review", "explaining the code first; a question that needs only an explanation ends there", "A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape", "never send the user to read a file", "restate their model, name the exact premise where you differ", "Where it is silent, follow how the codebase, tool, or library in use does the same job"]) {
      expect(tuned).toContain(commitment);
    }
    expect(tuned).not.toContain("trivial edits");
    expect(tuned).toContain("Guidelines:");
    expect(tuned).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
  });

  it("states only the commitments that the request surface can honor", () => {
    const tuned = build({ tools: TOOLS, chatPrompt: "sonnet-5.5" });
    expect(tuned).not.toContain("**Chat leads a change through delivery.**");
    expect(tuned).not.toContain("end your reply with three things");
    expect(tuned).not.toContain("**Orchestration pays for itself.**");
    expect(tuned).toContain("review it yourself against the intent");
    expect(tuned).toContain("number them and state the one you recommend");
    // No skill, memory, workflow, or subagent tool: the body names none of them and keeps each method.
    for (const absent of ["`design` skill", "memory", "subagent", "workflow", "the recorded history"]) expect(tuned).not.toContain(absent);
    expect(tuned).toContain("restate their model, name the exact premise where you differ");
    expect(tuned).toContain("run it in the scratchpad before you design on the claim");
    const noShell = build({ tools: [spec("read")], chatPrompt: "sonnet-5.5" });
    expect(noShell).toContain("settle that with the tools you have, or report it as an unverified assumption");
    expect(noShell).not.toContain("probe");
    // Workflows alone: the orchestration commitment names only the workflow route.
    const workflows = build({ tools: [...TOOLS, spec("workflow"), spec("ask_user")], chatPrompt: "sonnet-5.5" });
    expect(workflows).toContain("**Orchestration pays for itself.** Add a reviewer or start a workflow only on a named trigger");
    expect(workflows).toContain("**Chat leads a change through delivery.**");
  });

  it("adds each model's own sections and shell note, and the shell note only with a shell", () => {
    const opus = build({ chatPrompt: "opus-5.5" });
    const sonnet = build({ chatPrompt: "sonnet-5.5" });
    const fable = build({ chatPrompt: "fable-5.1" });
    const shellNote = (body: string): string | undefined => body.split("\n\n").find((paragraph) => paragraph.startsWith("The `bash` tool") || paragraph.startsWith("Use the `bash` tool"));

    // Opus may choose the shell or the file tools; Fable prefers the shell; Sonnet gets no shell note.
    // The shell note names only the file tools that the request has.
    expect(shellNote(opus)).not.toContain("when a shell edit is fragile");
    expect(shellNote(build({ chatPrompt: "opus-5.5", tools: [...TOOLS, spec("edit"), spec("write")] }))).toContain("Use `edit` or `write` when a shell edit is fragile");
    expect(shellNote(fable)).toContain("Use `read` only when bash cannot do the job");
    expect(shellNote(build({ chatPrompt: "fable-5.1", tools: [...TOOLS, spec("edit"), spec("write")] }))).toContain("Use `read`, `edit`, or `write` only when bash cannot do the job");
    expect(shellNote(sonnet)).toBeUndefined();
    expect(shellNote(build({ chatPrompt: "opus-5.5", tools: TOOLS.filter((tool) => tool.name !== "bash") }))).toBeUndefined();
    expect(shellNote(build({ chatPrompt: "fable-5.1", tools: TOOLS.filter((tool) => tool.name !== "bash") }))).toBeUndefined();

    for (const shared of ["# This session", "# Acting", "they/them", "you resume from your session notes. Never"]) {
      for (const body of [opus, sonnet, fable]) expect(body).toContain(shared);
    }
    expect(build({ chatPrompt: "opus-5.5", tools: [...TOOLS, spec("recall")] })).toContain("session notes and the recorded history");
    for (const fableOnly of ["# Scope", "# The final message", "# Ending the turn", "Open with one line on what you will do"]) {
      expect(fable).toContain(fableOnly);
      expect(opus).not.toContain(fableOnly);
      expect(sonnet).not.toContain(fableOnly);
    }
    const codeStyle = "copy that file's naming, idioms, and amount of commenting";
    expect(opus).toContain(codeStyle);
    expect(sonnet).toContain(codeStyle);
    expect(fable).not.toContain(codeStyle);
    for (const body of [opus, sonnet, fable]) expect(body).not.toContain("\u2014");
  });

  it("keeps the general prompt outside interactive chat even for a tuned model", () => {
    const subagent = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "subagent", chatPrompt: "opus-5.5" }));
    expect(subagent).toBe(buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "subagent" })));
  });

});
