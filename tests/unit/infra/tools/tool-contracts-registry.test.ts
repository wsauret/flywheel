import { describe, it, expect } from "bun:test";
import { getToolDisplay, getToolDisplayName, resolvePresentationIfReady, resolveToolPresentation, resolveToolRowPresentation } from "../../../../src/infra/tools/tool-display-registry.js";
import { normalizeSkillId } from "../../../../src/infra/skill-id.js";
import { testBaseTools, testKernelToolDeps } from "../../../helpers/request-tool-surface.js";
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js";
import type { ToolRegistration } from "../../../../src/orchestration/agent-runtime/tools/tool-registry.js";

import { createToolRegistry } from "../../../../src/orchestration/tool-catalog.js";
import { SHIPPED_MODULES } from "../../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../../src/orchestration/development-modules.js";
const toolRegistrations = Object.fromEntries(createToolRegistry());

/** Whether a bare kernel with handoff capture builds the registration alone. */
function buildsAlone(registration: ToolRegistration): boolean {
  return registration.create({ kernel: testKernelToolDeps({ handoff: {} }), modules: NO_MODULE_RUNTIMES }).tool !== undefined;
}
describe("base tool display names", () => {
  const expectations: Array<[string, string]> = [
    ["read", "Read"],
    ["write", "Write"],
    ["edit", "Edit"],
    ["bash", "Bash"],
    ["exec", "Bash"],
    ["search", "Search"],
    ["list", "List"],
    ["handoff", "Handoff"],
    ["subagent", "Subagent"],
    ["workflow", "Workflow"],
    ["step", "Step"],
    ["recall", "Recall"],
    ["ask_user", "Ask User"],
  ];

  for (const [name, expected] of expectations) {
    it(`${name} -> ${expected}`, () => {
      expect(getToolDisplayName(name)).toBe(expected);
    });
  }
});

describe("workflow call sentences", () => {
  it.each([
    ["read", { path: "src/tui/workflow-card.tsx", offset: 27, limit: 423 }, "Read", "workflow-card.tsx:28-450"],
    ["edit", { path: "src/tui/workflow-card.tsx" }, "Edited", "workflow-card.tsx"],
    ["apply_patch", { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** End Patch" }, "Edited", "a.ts, b.ts"],
    ["write", { path: "notes/checkpoint.md" }, "Wrote", "checkpoint.md"],
    ["search", { pattern: "workflowSeatPair", path: "src/tui", limit: 5 }, "Searched", "workflowSeatPair in src/tui"],
    ["list", { path: "src/tui", limit: 5 }, "Listed", "src/tui"],
    ["subagent", { persona: "explorer", description: "Find the owner" }, "Dispatched", "explorer"],
    ["ask_user", { question: "Proceed?" }, "Asked", "you"],
    ["skill", { action: "load", skill_id: "tldr" }, "Loaded", "skill tldr"],
    ["skill", { action: "resource", skill_id: "tldr", path: "references/rules.txt" }, "Read", "skill tldr/references/rules.txt"],
    ["bash", { command: "bun run test" }, "Ran", "bun run test"],
    ["bash", { command: "cat src/model-access.md | head -20" }, "Read", "model-access.md"],
    ["recall", { query: "the card" }, "Recalled", '"the card"'],
    ["bash", { mutates: true, command: "python3 scripts/rewrite.py" }, "Edited", "files with rewrite.py"],
    ["bash", { mutates: true, command: "cat > notes.md <<'EOF'\nbody\nEOF" }, "Wrote", "notes.md"],
    ["exec", { command: "git add -- a.py b.py && git commit -m 'fix: x'" }, "Staged", "a.py, b.py; Committed fix: x"],
    ["process", { action: "wait" }, "Waited", "for processes"],
    // A recorded wait of the retired gpt-6-luna process registration.
    ["process", { action: "wait", process_id: "bash-bg-1", wait_sec: 30 }, "Waited", "for bash-bg-1"],
    ["process", { action: "read_output", process_id: "bash-bg-1" }, "Read", "output of bash-bg-1"],
    ["web", { search_query: [{ q: "dbt unit tests" }] }, "Searched", "dbt unit tests"],
    ["web", { open: [{ ref_id: "https://docs.example.com/guide?x=1" }] }, "Opened", "docs.example.com/guide"],
    ["code", { source: "const issue = await tools.linear.get_issue({ id: 'PD-1' })" }, "Ran", "code calling linear.get_issue"],
    ["mcp__example__lookup", {}, "Called", "example.lookup"],
    ["linear.get_issue", { id: "PD-463" }, "Called", "linear.get_issue PD-463"],
    ["groundcover.query_logs", { tenant_uuid: "cb2c482a-2e2e-473e-afb3-5491fd9aa264", query: "service:zones" }, "Called", "groundcover.query_logs service:zones"],
  ])("%s builds a sentence separately from its transcript presentation", (tool, input, name, detail) => {
    const row = resolveToolRowPresentation(tool, input, "/project");
    expect(row.sentence).toEqual({ name, detail });
    expect(row.presentation).toEqual(resolveToolPresentation(tool, input, "/project"));
  });
});

describe("render-routing flags on ToolDisplay", () => {
  it("only dispatch operations and workflows render as agent blocks", () => {
    expect(getToolDisplay("workflow").rendersAsAgentBlock).toBe(true);
    const render = getToolDisplay("subagent").rendersAsAgentBlock;
    if (typeof render !== "function") throw new Error("Expected operation-sensitive rendering");
    expect(render({ kind: "dispatch" })).toBe(true);
    expect(render({ description: "Historical dispatch" })).toBe(true);
    for (const kind of ["steer", "resume", "retry"]) expect(render({ kind })).toBe(false);
    expect(render({})).toBe(false);
  });

});

describe("base tool getDetail", () => {
  const executionCwd = "/home/user/project";

  it("read: file path with line range", () => {
    expect(getToolDisplay("read").getDetail?.({ path: "/home/user/project/src/index.ts", offset: 10, limit: 20 }, executionCwd)).toBe("src/index.ts:11-30");
  });

  it("read: simple file path", () => {
    expect(getToolDisplay("read").getDetail?.({ path: "/home/user/project/src/index.ts" }, executionCwd)).toBe("src/index.ts");
  });

  it("write: file path", () => {
    expect(getToolDisplay("write").getDetail?.({ path: "/home/user/project/README.md" }, executionCwd)).toBe("README.md");
  });

  it("edit: file path", () => {
    expect(resolveToolPresentation("edit", { path: "/home/user/project/src/app.ts" }, executionCwd)).toEqual({ name: "Edit", detail: "src/app.ts" });
  });

  it("edit: waits for a path", () => {
    expect(resolvePresentationIfReady("edit", {}, executionCwd)).toBeNull();
  });

  it("bash: shortened command", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "ls /home/user/project/src" }, executionCwd)).toBe("ls src");
  });

  it("bash: displays direct shell scripts through bash", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "tests/e2e/tui-chat.sh" }, executionCwd)).toBe("bash tests/e2e/tui-chat.sh");
  });

  it("bash: preserves explicit bash script commands", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "bash tests/e2e/tui-chat.sh" }, executionCwd)).toBe("bash tests/e2e/tui-chat.sh");
  });

  it("bash: inserts bash after env assignments", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "CI=1 tests/e2e/tui-chat.sh --fast" }, executionCwd)).toBe("CI=1 bash tests/e2e/tui-chat.sh --fast");
  });

  it("bash: handles quoted shell script paths", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "'tests/e2e/tui-chat.sh' --fast" }, executionCwd)).toBe("bash 'tests/e2e/tui-chat.sh' --fast");
  });

  it("bash: inserts bash after command separators", () => {
    expect(getToolDisplay("bash").getDetail?.({ command: "echo ready && tests/e2e/tui-chat.sh" }, executionCwd)).toBe("echo ready && bash tests/e2e/tui-chat.sh");
  });

  it("search: pattern and directory", () => {
    expect(getToolDisplay("search").getDetail?.({ pattern: "TODO", path: "/home/user/project/src", glob: "*.ts" }, executionCwd)).toBe("\"TODO\" in src [*.ts]");
  });

  it("list: directory only", () => {
    expect(getToolDisplay("list").getDetail?.({ path: "/home/user/project/src" }, executionCwd)).toBe("src");
  });

  it("subagent: description via fallback", () => {
    expect(resolveToolPresentation("subagent", { description: "Search files" }, executionCwd)).toEqual({ name: "Subagent", detail: "Search files" });
  });

  it("workflow: short summary only", () => {
    expect(getToolDisplay("workflow").getDetail?.({ summary: "Fix test failures", description: "Long prompt" }, executionCwd)).toBe("Fix test failures");
  });

  it("step: step_id with short arguments preview", () => {
    const detail = getToolDisplay("step").getDetail?.({ step_id: "code-review", arguments: "focus on auth" }, executionCwd);
    expect(detail).toBe("code-review — focus on auth");
    expect(getToolDisplay("step").getDetail?.({ step_id: "code-review" }, executionCwd)).toBe("code-review");
  });

  it("recall: query, expand, page, and scope compose; bare call shows recent history", () => {
    const detail = getToolDisplay("recall").getDetail;
    if (typeof detail !== "function") throw new Error("Expected an argument-only detail display");
    expect(detail({ query: "auth bug" }, executionCwd)).toBe("\"auth bug\"");
    expect(detail({ query: "auth bug", expand: [3, 7], page: 2, scope: "all" }, executionCwd)).toBe("\"auth bug\" expand 3, 7 page 2 (scope: all)");
    expect(detail({}, executionCwd)).toBe("recent history");
  });

  it("ask_user: extracts question from input", () => {
    expect(getToolDisplay("ask_user").getDetail?.({ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }, executionCwd)).toBe("Continue?");
    expect(getToolDisplay("ask_user").verbs.past).toBe("Asked");
  });

  it("handoff: reads the first line of the summary it hands off", () => {
    expect(getToolDisplay("handoff").getDetail?.({ summary: "The wait command exited 0.\nThe gate file exists.", artifacts: {} }, executionCwd)).toBe("The wait command exited 0.");
    expect(getToolDisplay("handoff").getDetail?.({ artifacts: {} }, executionCwd)).toBeNull();
  });
});

describe("extractDiff", () => {
  it("write: returns content for large files so the TUI can preview and expand", () => {
    const bigContent = Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n");
    const result = getToolDisplay("write").extractDiff!({ path: "big.ts", content: bigContent }, "/scratch");
    expect(result).toBeDefined();
    expect(result!.content).toBe(bigContent);
    expect(result!.filetype).toBe("typescript");
  });

  it("handoff: returns the captured JSON content", () => {
    const result = getToolDisplay("handoff").extractDiff!({
      summary: "done",
      artifacts: { changed: ["src/app.ts"] },
    }, "/scratch");

    expect(result).toBeDefined();
    expect(result!.filetype).toBe("json");
    expect(result!.content).toBe(JSON.stringify({
      summary: "done",
      artifacts: { changed: ["src/app.ts"] },
    }, null, 2));
  });
});

describe("fallback for unknown tools", () => {
  it("synthesizes a tool for unknown names", () => {
    const c = getToolDisplay("SomeRandomTool");
    expect(c.displayName).toBe("SomeRandomTool");
    expect(c.rendersAsAgentBlock).toBeFalsy();
    expect(c.extractDiff).toBeUndefined();
  });

  it("handles MCP prefixed tools", () => {
    expect(getToolDisplayName("mcp__github__create_issue")).toBe("MCP github");
  });

  // The fallback names a row by its raw identifier and presents it as a
  // command, so a shipped tool that reached it would group and read wrong.
  it("is never what a tool Flywheel ships gets", () => {
    const shipped = [...createToolRegistry([...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]).values()].map(({ tool }) => tool);
    expect(shipped.filter((name) => getToolDisplayName(name) === name)).toEqual([]);
  });
});

describe("testBaseTools registry", () => {
  it("contains exactly the registrations that expose definitions or resolve test-owned surfaces", () => {
    const selfContained = Object.entries(toolRegistrations)
      .filter(([, entry]) => buildsAlone(entry))
      .map(([name]) => name);
    expect([...testBaseTools().keys()].sort()).toEqual(selfContained.sort());
  });
});

describe("resolveToolPresentation", () => {
  const executionCwd = "/home/user/project";

  it("keeps the raw tool identifier separate from the canonical presentation name", () => {
    expect(getToolDisplay("skill").name).toBe("skill");
    expect(resolveToolPresentation("skill", { action: "list" }, executionCwd).name).toBe("List Skills");
    expect(getToolDisplay("bash").name).toBe("bash");
    expect(resolveToolPresentation("bash", { command: "ls src" }, executionCwd)).toEqual({ name: "Bash", detail: "ls src" });
    expect(getToolDisplay("SomeRandomTool").name).toBe("somerandomtool");
    expect(resolveToolPresentation("SomeRandomTool", { subject: "anything" }, executionCwd)).toEqual({ name: "SomeRandomTool", detail: "anything" });
  });

  it("keeps invocation presentation independent of settlement and accepts only trusted target context", () => {
    const control = { kind: "steer", session_id: "child", display_goal: "Invented name" };
    expect(resolveToolPresentation("subagent", control, executionCwd)).toEqual({ name: "Subagent steer", detail: "" });
    expect(resolveToolPresentation("subagent", control, executionCwd, { targetDescription: "Recorded goal" })).toEqual({ name: "Subagent steer", detail: "Recorded goal" });
    const message = { to: "child", text: "Use the old parser" };
    expect(getToolDisplay("message_session").invocationBody?.(message)).toEqual({ content: message.text, filetype: "text", presentation: "disclosure" });
    expect(resolveToolPresentation("message_session", message, executionCwd)).toEqual({ name: "Message to", detail: "child" });
    expect(resolveToolPresentation("message_session", message, executionCwd, { targetDescription: "Recorded goal" })).toEqual({ name: "Message to", detail: "Recorded goal" });
    const input = { action: "save", name: "snowflake-cli-query" };
    const resolved = Array.from({ length: 6 }, () => resolveToolPresentation("skill_manage", input, executionCwd));
    for (const presentation of resolved) {
      expect(presentation).toEqual({ name: "Save Skill", detail: "snowflake-cli-query" });
    }
  });

  it("retains ordinary tool display names and argument details", () => {
    expect(resolveToolPresentation("read", { path: "/home/user/project/src/index.ts", offset: 10, limit: 20 }, executionCwd)).toEqual({ name: "Read", detail: "src/index.ts:11-30" });
    expect(resolveToolPresentation("search", { pattern: "TODO", path: "/home/user/project/src", glob: "*.ts" }, executionCwd)).toEqual({ name: "Search", detail: "\"TODO\" in src [*.ts]" });
    expect(resolveToolPresentation("edit", {}, executionCwd)).toEqual({ name: "Edit", detail: "" });
    expect(resolveToolPresentation("edit", { input: "@@ src/a.ts\n= 1aa..1aa\n~a\n@@ src/b.ts\n= 1bb..1bb\n~b" }, executionCwd)).toEqual({ name: "Edit", detail: "" });
    expect(resolveToolPresentation("write", { path: ".flywheel/sessions/abc/handoff.json" }, executionCwd).name).toBe("Write Handoff");
  });

  it("skill list: bare call has no detail and every modifier is argument-only", () => {
    const list = (input: { [key: string]: unknown }) => resolveToolPresentation("skill", { action: "list", ...input }, executionCwd);
    expect(list({})).toEqual({ name: "List Skills", detail: "" });
    expect(list({ query: "startup performance" }).detail).toBe("\"startup performance\"");
    expect(list({ limit: 20 }).detail).toBe("| head -20");
    expect(list({ query: "startup performance", limit: 20 }).detail).toBe("\"startup performance\" | head -20");
    expect(list({ offset: 20 }).detail).toBe("| offset 20");
    expect(list({ offset: 0 }).detail).toBe("");
    expect(list({ page: 2 }).detail).toBe("| page 2");
    expect(list({ query: "startup performance", limit: 20, offset: 40 }).detail).toBe("\"startup performance\" | head -20 | offset 40");
  });

  it("skill load: canonical name plus the skill id only", () => {
    expect(resolveToolPresentation("skill", { action: "load", skill_id: "tui-rendering" }, executionCwd)).toEqual({ name: "Load Skill", detail: "tui-rendering" });
    expect(resolveToolPresentation("skill", { action: "load" }, executionCwd)).toEqual({ name: "Load Skill", detail: "" });
  });

  it("skill resource: skill_id/path detail, with an offset modifier only when nonzero", () => {
    const resource = (input: { [key: string]: unknown }) => resolveToolPresentation("skill", { action: "resource", ...input }, executionCwd);
    expect(resource({ skill_id: "tui-rendering", path: "references/colors.md" })).toEqual({ name: "Read Skill Resource", detail: "tui-rendering/references/colors.md" });
    expect(resource({ skill_id: "tui-rendering", path: "references/colors.md", offset: 0 }).detail).toBe("tui-rendering/references/colors.md");
    expect(resource({ skill_id: "tui-rendering", path: "references/colors.md", offset: 64000 }).detail).toBe("tui-rendering/references/colors.md | offset 64000");
  });

  it("skill: malformed historical input uses a neutral skill name without raw input", () => {
    const presentation = resolveToolPresentation("skill", { action: "frobnicate", skill_id: "tui-rendering", body: "raw package text" }, executionCwd);
    expect(presentation).toEqual({ name: "Read Skill", detail: "" });
    expect(resolveToolPresentation("skill", {}, executionCwd)).toEqual({ name: "Read Skill", detail: "" });
  });

  it("skill_manage: save stays Save Skill and names the skill only", () => {
    const manage = (input: { [key: string]: unknown }) => resolveToolPresentation("skill_manage", input, executionCwd);
    expect(manage({ action: "save", name: "snowflake-cli-query" })).toEqual({ name: "Save Skill", detail: "snowflake-cli-query" });
    expect(manage({ action: "save", name: "snowflake-cli-query", path: "scripts/query.sh" })).toEqual({ name: "Write Skill File", detail: "snowflake-cli-query/scripts/query.sh" });
  });

  it("skill_manage: every remaining approved action name", () => {
    const manage = (input: { [key: string]: unknown }) => resolveToolPresentation("skill_manage", { name: "snowflake-cli-query", ...input }, executionCwd);
    expect(manage({ action: "patch" })).toEqual({ name: "Patch Skill", detail: "snowflake-cli-query" });
    expect(manage({ action: "patch", path: "references/schema.md" })).toEqual({ name: "Patch Skill File", detail: "snowflake-cli-query/references/schema.md" });
    expect(manage({ action: "remove_file", path: "scripts/query.sh" })).toEqual({ name: "Remove Skill File", detail: "snowflake-cli-query/scripts/query.sh" });
    expect(manage({ action: "archive" })).toEqual({ name: "Archive Skill", detail: "snowflake-cli-query" });
    expect(manage({ action: "restore" })).toEqual({ name: "Restore Skill", detail: "snowflake-cli-query" });
    expect(manage({ action: "promote" })).toEqual({ name: "Promote Skill", detail: "snowflake-cli-query" });
    expect(manage({ action: "recommend" })).toEqual({ name: "Recommend Skill Promotion", detail: "snowflake-cli-query" });
  });

  it("skill_manage: malformed historical input falls back to Manage Skill and exposes no argument", () => {
    expect(resolveToolPresentation("skill_manage", { action: "merge", name: "snowflake-cli-query" }, executionCwd)).toEqual({ name: "Manage Skill", detail: "" });
    expect(resolveToolPresentation("skill_manage", {}, executionCwd)).toEqual({ name: "Manage Skill", detail: "" });
    expect(resolveToolPresentation("skill_manage", { action: "save", name: "Raw body: not a slug" }, executionCwd)).toEqual({ name: "Save Skill", detail: "" });
  });

  it("skill_manage: the detail is the normalized package id execution mutates", () => {
    expect(resolveToolPresentation("skill_manage", { action: "save", name: " Example-Skill " }, executionCwd)).toEqual({ name: "Save Skill", detail: "example-skill" });
    expect(normalizeSkillId(" Example-Skill ")).toBe("example-skill");
  });

  it("memory: single operations resolve to the approved singular names with only the normalized title", () => {
    const memory = (input: { [key: string]: unknown }) => resolveToolPresentation("memory", input, executionCwd);
    expect(memory({ action: "add", target: "memory", title: "Use Bun for project scripts", content: "Repo uses Bun." })).toEqual({ name: "Add Memory", detail: "Use Bun for project scripts" });
    expect(memory({ action: "replace", target: "memory", title: "Update the tooling note", old_text: "Uses npm.", content: "Uses Bun." })).toEqual({ name: "Replace Memory", detail: "Update the tooling note" });
    expect(memory({ action: "remove", target: "user", title: "Remove an obsolete preference", old_text: "Raw memory content." })).toEqual({ name: "Remove Memory", detail: "Remove an obsolete preference" });
  });

  it("memory: homogeneous batches are plural and mixed batches are Change Memories", () => {
    const batch = (operations: unknown[]) => resolveToolPresentation("memory", { target: "user", title: "Update tooling preferences", operations }, executionCwd);
    expect(batch([{ action: "add", content: "a" }, { action: "add", content: "b" }]).name).toBe("Add Memories");
    expect(batch([{ action: "replace", content: "a" }, { action: "replace", content: "b" }]).name).toBe("Replace Memories");
    expect(batch([{ action: "remove", old_text: "a" }, { action: "remove", old_text: "b" }]).name).toBe("Remove Memories");
    expect(batch([{ action: "add", content: "a" }, { action: "remove", old_text: "b" }]).name).toBe("Change Memories");
    expect(batch([{ action: "add", content: "a" }]).name).toBe("Add Memory");
  });

  it("memory: malformed historical input uses Change Memory or Change Memories and never raw content", () => {
    expect(resolveToolPresentation("memory", { action: "merge", target: "memory", title: "Reconcile project conventions" }, executionCwd)).toEqual({ name: "Change Memory", detail: "Reconcile project conventions" });
    expect(resolveToolPresentation("memory", { action: "add", target: "memory", content: "Raw memory content." }, executionCwd)).toEqual({ name: "Add Memory", detail: "" });
    expect(resolveToolPresentation("memory", { action: "add", target: "memory", title: "\u0085\u200B", content: "Raw memory content." }, executionCwd)).toEqual({ name: "Add Memory", detail: "" });
    expect(resolveToolPresentation("memory", { operations: [{ content: "a" }, { content: "b" }], content: "Raw memory content." }, executionCwd)).toEqual({ name: "Change Memories", detail: "" });
  });

  it("memory: details carry no colon, action token, target, or store path", () => {
    const details = [
      resolveToolPresentation("memory", { action: "add", target: "memory", title: "Use Bun for project scripts", content: "Repo uses Bun." }, executionCwd).detail,
      resolveToolPresentation("memory", { target: "user", title: "Update tooling preferences", operations: [{ action: "add", content: "a" }, { action: "remove", old_text: "b" }] }, executionCwd).detail,
    ];
    for (const detail of details) {
      expect(detail).not.toInclude(":");
      expect(detail).not.toInclude("memory");
      expect(detail).not.toInclude("add");
      expect(detail).not.toInclude("Repo uses Bun.");
    }
  });

  it("memory: normalizes the generated title through the shared boundary", () => {
    expect(resolveToolPresentation("memory", { action: "replace", target: "memory", title: `${"A".repeat(58)}\u{1F469}\u200D\u{1F4BB}\r\nB\rC` }, executionCwd).detail).toBe(`${"A".repeat(58)}\u{1F469}\u200D\u{1F4BB}\u2026`);
    expect(resolveToolPresentation("memory", { action: "add", target: "memory", title: "First\u0085Second\u2028Third\u2029Fourth" }, executionCwd).detail).toBe("First Second Third Fourth");
  });
});

describe("presentation readiness", () => {
  const executionCwd = "/home/user/project";

  it("reports not ready only while the input names no operation, for both resolver consumers", () => {
    // Streaming materialization waits on this; the final projection falls back
    // to the neutral family name for exactly the same inputs.
    expect(resolvePresentationIfReady("skill", {}, executionCwd)).toBeNull();
    expect(resolvePresentationIfReady("skill", { action: "lo" }, executionCwd)).toBeNull();
    expect(resolvePresentationIfReady("skill_manage", { name: "example-skill" }, executionCwd)).toBeNull();
    expect(resolvePresentationIfReady("skill", { action: "load" }, executionCwd)).toEqual({ name: "Load Skill", detail: "" });
    expect(resolvePresentationIfReady("skill_manage", { action: "save", name: "example-skill" }, executionCwd)).toEqual({ name: "Save Skill", detail: "example-skill" });
    // Memory names one operation family, so a call is always ready.
    expect(resolvePresentationIfReady("memory", {}, executionCwd)).toEqual({ name: "Change Memory", detail: "" });
    // Legacy detail displays stay ready exactly when they have a detail.
    expect(resolvePresentationIfReady("read", {}, executionCwd)).toBeNull();
    expect(resolvePresentationIfReady("read", { path: "/home/user/project/src/index.ts" }, executionCwd)).toEqual({ name: "Read", detail: "src/index.ts" });
  });

});

describe("presentation sanitization", () => {
  const executionCwd = "/home/user/project";

  it("reduces a name and a detail to one logical line", () => {
    const presentation = resolveToolPresentation("bash", { command: "echo one\necho two\r\nline\u2028sep\u2029ok" }, executionCwd);
    expect(presentation.detail).toBe("echo one echo two line sep ok");
    expect(presentation.name).toBe("Bash");
  });

  it("removes ESC/CSI, OSC, C1, and bidi bytes from the detail", () => {
    const detail = (command: string) => resolveToolPresentation("bash", { command }, executionCwd).detail;
    expect(detail("\u001b[31mred\u001b[0m")).toBe("red");
    expect(detail("\u001b]0;window title\u0007ls")).toBe("ls");
    expect(detail("plain\u0085\u0090text")).toBe("plain");
    expect(detail("safe\u202Ereversed\u202C")).toBe("safereversed");
    expect(detail("a\u200Fb\u2066c\u2069")).toBe("abc");
    for (const raw of ["\u001b[31mred\u001b[0m", "\u001b]0;title\u0007ls", "plain\u0085\u0090text", "safe\u202Ereversed\u202C"]) {
      expect(detail(raw)).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    }
  });

  it("preserves ordinary search punctuation", () => {
    expect(resolveToolPresentation("search", { pattern: "TODO|FIXME.*\\d+", path: "/home/user/project/src", glob: "*.ts" }, executionCwd).detail)
      .toBe("\"TODO|FIXME.*\\d+\" in src [*.ts]");
  });

  it("sanitizes the neutral fallback name of a tool nobody registered", () => {
    expect(resolveToolPresentation("Some\u001b[1mTool", {}, executionCwd).name).toBe("SomeTool");
  });
});
