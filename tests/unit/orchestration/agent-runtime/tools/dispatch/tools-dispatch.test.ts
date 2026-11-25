import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBashDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/bash/bash.js";
import { loadBashParser } from "../../../../../../src/orchestration/agent-runtime/tools/bash/policy/bash-parser.js";
import { createHandoffTool, handoffDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/sessions/handoff.js";
import { handoffToolSchemaFromOutput } from "../../../../../../src/orchestration/agent-runtime/tools/sessions/handoff-tool-schema.js";
import { compileOutput } from "../../../../../../src/workflows/output-contract/compile.js";
import type { OutputObject } from "../../../../../../src/workflows/output-contract/grammar.js";
import { executePreparedTool, prepareToolCall, preparedToolAdmission, selectedToolNames, type ToolExecutionGate } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-dispatch.js";
import type { RuntimeTool, RuntimeToolInput } from "../../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { AgentOptions } from "../../../../../../src/orchestration/agent-runtime/types.js";
import { createSkillTool } from "../../../../../../src/orchestration/agent-runtime/tools/definitions/skill.js";
import type { SkillDefinition } from "../../../../../../src/workflows/skills/skill-schema.js";
import { publishSkillRevision } from "../../../../../../src/workflows/skills/skill-schema.js";
import { admitEveryTool, requestAdmission, testBaseTools } from "../../../../../helpers/request-tool-surface.js";
import { capabilityAccessHolding, makeContext } from "../_fixtures.js";
import { bashExecution } from "../bash/_bash-fixtures.js";
import { composeFirstPartyModules } from "../../../../../../src/orchestration/module-composition.js";
import type { ModuleId } from "../../../../../../src/orchestration/module-catalog.js";
import { executeDispatchedTool } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/nested-tool-dispatch.js";
import { shortFormTool } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/short-form.js";
import type { ToolConcurrencyGate } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-concurrency-gate.js";

const bashDefinition = createBashDefinition(bashExecution());

beforeAll(loadBashParser);
// Compose prepare + execute exactly as the agent loop's dispatcher does.
const runTool = (
  call: Parameters<typeof prepareToolCall>[0],
  ctx: Parameters<typeof executePreparedTool>[1],
  tools: Parameters<typeof prepareToolCall>[1],
  options?: Parameters<typeof executePreparedTool>[2],
) => executePreparedTool(prepareToolCall(call, tools, admitEveryTool), ctx, options);

function toolCall(name: string, input: { [key: string]: unknown }) {
  return { id: `test-${name}`, name, input };
}

const runnerOptions = (toolActions: AgentOptions["toolActions"]): AgentOptions => ({
  model: "test",
  executionCwd: "/scratch",
  projectRoot: "/scratch",
  userDataRoot: "/scratch/.test-account",
  accountHome: "/scratch",
  onEvent: () => {},
  purpose: { kind: "interactive-chat" },
  conversation: { kind: "stateless" },
  lifecycle: { kind: "one-shot" },
  toolActions,
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("tool dispatch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-dispatch-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps busy tools alive when they report execution output", async () => {
    const busyTool = {
      name: "busy_tool",
      action: "shell_exec" as const,
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async (_input, context) => {
        for (let i = 0; i < 9; i += 1) {
          await wait(10);
          context.onExecutionOutput?.(`tick ${i}`);
        }
        return { content: "done", outcome: "ok" as const };
      },
    } satisfies RuntimeTool;
    const emitted: string[] = [];
    const tools = new Map<string, RuntimeTool>([[busyTool.name, busyTool]]);

    const result = await runTool(
      toolCall("busy_tool", {}),
      makeContext({ onExecutionOutput: (text) => emitted.push(text) }),
      tools,
      { watchdogMs: 100 },
    );

    expect(result).toEqual({ content: "done", outcome: "ok" });
    expect(emitted).toContain("tick 8");
  });

  it("aborts silent tools after the watchdog window and keeps the account they return", async () => {
    const silentTool = {
      name: "silent_tool",
      action: "shell_exec" as const,
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async (_input, context) => {
        for (let i = 0; i < 5 && !context.signal?.aborted; i += 1) {
          await wait(10);
        }
        return { content: "the request may have reached the server", outcome: "ok" as const };
      },
    } satisfies RuntimeTool;
    const tools = new Map<string, RuntimeTool>([[silentTool.name, silentTool]]);

    const result = await runTool(toolCall("silent_tool", {}), makeContext(), tools, { watchdogMs: 30 });

    expect(result.outcome).toBe("error");
    expect(result.content).toStartWith("Tool 'silent_tool' was aborted after 0.03s without reporting any activity/output.");
    expect(result.content).toContain("stream progress output");
    expect(result.content).toEndWith("\nthe request may have reached the server");
  });

  it("does not abort unbounded-duration tools", async () => {
    let sawAbort = false;
    const unboundedTool = {
      name: "unbounded_tool",
      action: "ask_user" as const,
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      unboundedDuration: true,
      execute: async (_input, context) => {
        for (let i = 0; i < 5; i += 1) {
          await wait(10);
          sawAbort ||= context.signal?.aborted === true;
        }
        return { content: "done", outcome: "ok" as const };
      },
    } satisfies RuntimeTool;
    const tools = new Map<string, RuntimeTool>([[unboundedTool.name, unboundedTool]]);

    const result = await runTool(toolCall("unbounded_tool", {}), makeContext(), tools, { watchdogMs: 30 });

    expect(result).toEqual({ content: "done", outcome: "ok" });
    expect(sawAbort).toBe(false);
  });

  it("coerces stringified primitives before reaching the tool", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b");
    const ctx = makeContext({ executionCwd: tmpDir });
    // limit is declared `type: "number"`. The model sent it as "1".
    const result = await runTool(
      toolCall("list", { path: ".", limit: "1" }),
      ctx,
      testBaseTools(),
    );
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Results truncated");
  });

  it("tells the model about each argument repair, and keeps a repair only when the repaired input validates", async () => {
    let received: RuntimeToolInput | undefined;
    const tool = {
      name: "notes",
      action: "file_read" as const,
      description: "test tool",
      inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } }, required: ["path"] },
      isConcurrencySafe: true,
      execute: async (input: RuntimeToolInput) => {
        received = input;
        return { content: "ran", outcome: "ok" as const };
      },
    } satisfies RuntimeTool;
    const tools = new Map([[tool.name, tool]]);

    const repaired = await runTool(toolCall("notes", { file_path: "a.txt", limit: null }), makeContext(), tools);
    expect(received).toEqual({ path: "a.txt" });
    expect(repaired).toEqual({ content: "Note: `file_path` was read as `path`.\nNote: `limit` was null, so it was left out.\nran", outcome: "ok" });

    const invalid = prepareToolCall(toolCall("notes", { file_path: "a.txt", lmit: 5 }), tools, admitEveryTool);
    expect(invalid.call.inputRepairs).toBeUndefined();
    expect(invalid.input).toEqual({ file_path: "a.txt", lmit: 5 });
    expect(invalid.validationResult?.content).toContain("The required parameter `path` is missing");
  });

  it("returns a model-visible error when tool arguments failed to parse", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const call = {
      id: "test-parse-error",
      name: "read",
      input: {},
      inputParseError: 'the argument text is not parseable as JSON. Raw argument text received: {"path": broken',
    };
    const result = await runTool(call, ctx, testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("failed to parse tool arguments");
    expect(result.content).toContain('{"path": broken');
    expect(result.content).toContain("Re-send the call");
  });

  it("validates after shared and tool-owned repairs on direct and gated paths", async () => {
    let preparations = 0;
    const received: RuntimeToolInput[] = [];
    const tool: RuntimeTool = {
      name: "repair_probe", action: "ui_meta", description: "repair order", isConcurrencySafe: true,
      inputSchema: { type: "object", properties: { value: { type: "number" }, limit: { type: "number" } }, required: ["value"] },
      prepareAdmission: async (input) => {
        preparations++;
        const { model_value, ...rest } = input;
        return { repair: { input: { ...rest, value: model_value }, notice: "Note: model_value was read as value." } };
      },
      execute: async (input) => { received.push(input); return { content: "ran", outcome: "ok" }; },
    };
    const tools = new Map([[tool.name, tool]]);
    for (const gated of [false, true]) {
      const prepared = prepareToolCall(toolCall(tool.name, { model_value: 2, limit: "3" }), tools, admitEveryTool);
      if (gated) expect(await preparedToolAdmission(prepared, makeContext())).toEqual({ kind: "safe" });
      expect(await executePreparedTool(prepared, makeContext())).toEqual({ content: "Note: the text value of `limit` was read as a number.\nNote: model_value was read as value.\nran", outcome: "ok" });
      expect(prepared.call.inputRepairs).toEqual([{ kind: "parsed_value", path: "limit", type: "number" }]);
    }
    expect(preparations).toBe(2);
    expect(received).toEqual([{ value: 2, limit: 3 }, { value: 2, limit: 3 }]);
    const invalid = prepareToolCall(toolCall(tool.name, { model_value: "bad" }), tools, admitEveryTool);
    const result = await executePreparedTool(invalid, makeContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("The required parameter `value` is missing");
    expect(invalid.input).toEqual({ model_value: "bad" });
    expect(invalid.repairNotice).toBeUndefined();
  });

  // ARCH-TOOLS-058: a short-form tool names the inputs that a call needs in its one line, answers a call with no
  // arguments with its contract, refuses an invalid call with its problems and the contract, and runs a valid call
  // after the shared repairs.
  it("names a short-form tool's required inputs, answers its empty call with its contract, an invalid call with problems and the contract, and runs a valid call", async () => {
    let preparations = 0;
    const received: RuntimeToolInput[] = [];
    const full: RuntimeTool = {
      name: "probe", action: "ui_meta", description: "Probe the full description.", promptGuidelines: ["Probe guideline."], isConcurrencySafe: true,
      inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
      prepareAdmission: async () => { preparations++; return {}; }, execute: async (input) => { received.push(input); return { content: "ran", outcome: "ok" }; },
    };
    const tool = shortFormTool(full, "Probe things.");
    expect(tool.description).toBe("Probe things. Required inputs: value. Call with {} to read its full contract first.");
    const tools = new Map([[tool.name, tool]]);
    const contract = tool.contract?.() ?? "";
    for (const part of ["Probe the full description.", "- Probe guideline.", JSON.stringify(full.inputSchema)]) expect(contract).toContain(part);

    expect(await runTool(toolCall("probe", {}), makeContext(), tools)).toEqual({ content: contract, outcome: "ok", details: { contractRead: true } });
    const invalid = await runTool(toolCall("probe", { value: "many" }), makeContext(), tools);
    expect([invalid.outcome, received.length, preparations]).toEqual(["error", 0, 1]);
    expect([String(invalid.content).startsWith("probe failed due to the following issue:"), String(invalid.content).endsWith(`\n\n${contract}`)]).toEqual([true, true]);

    expect(await runTool(toolCall("probe", { value: "2" }), makeContext(), tools)).toEqual({ content: "Note: the text value of `value` was read as a number.\nran", outcome: "ok" });
    expect(received).toEqual([{ value: 2 }]);
  });

  it("reports missing required parameters before executing the tool", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await runTool(toolCall("read", {}), ctx, testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("read failed due to the following issue:");
    expect(result.content).toContain("The required parameter `path` is missing");
  });

  it("reads a uniquely normalized parameter name", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "content");
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await runTool(toolCall("read", { Path: "a.txt" }), ctx, testBaseTools());
    expect(result.outcome).toBe("ok");
    expect(String(result.content)).toStartWith("Note: `Path` was read as `path`.");
  });

  it("reports enum violations with the allowed values", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await runTool(toolCall("list", { path: ".", include: "folders" }), ctx, testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("The parameter `include` is expected as one of");
  });

  it("reports type mismatches coercion could not fix", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await runTool(toolCall("read", { path: { invalid: true } }), ctx, testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("The parameter `path` type is expected as `string` but provided as `object`");
  });

  it("skips central validation for self-validating tools", async () => {
    // handoff runs collapsed-payload recovery before its own schema checks;
    // central validation must not pre-empt that conversation.
    expect(handoffDefinition.validatesOwnInput).toBe(true);
    // Prove the dispatcher honors the flag with a strict schema that central
    // validation would reject: execute must still run.
    let executed = false;
    const strictTool = {
      name: "self_validating",
      action: "shell_exec" as const,
      description: "test tool",
      inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      isConcurrencySafe: false,
      validatesOwnInput: true as const,
      execute: async () => {
        executed = true;
        return { content: "ran", outcome: "ok" as const };
      },
    };
    const tools = new Map(testBaseTools());
    tools.set(strictTool.name, strictTool);
    const result = await runTool(toolCall("self_validating", { undeclared_extra: 1 }), makeContext(), tools);
    expect(executed).toBe(true);
    expect(result.outcome).toBe("ok");
  });

  it("gives a vetoing gate immutable data and refuses the call with its reason without running core", async () => {
    let coreExecuted = false;
    const tool = {
      name: "vetoable",
      action: "shell_exec" as const,
      description: "veto probe",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      isConcurrencySafe: true,
      execute: async () => { coreExecuted = true; return { content: "core", outcome: "ok" as const }; },
    } satisfies RuntimeTool;
    const gate: ToolExecutionGate = (gateInput) => {
      expect(Object.keys(gateInput).sort()).toEqual(["call", "executionCwd", "input", "modules", "preparedReservedPaths", "tool"]);
      expect(gateInput.tool).toBe("vetoable");
      expect(Object.isFrozen(gateInput)).toBe(true);
      expect(Object.isFrozen(gateInput.call)).toBe(true);
      expect(Object.isFrozen(gateInput.input)).toBe(true);
      expect(gateInput.call.input).toBe(gateInput.input);
      expect(Object.isFrozen(gateInput.preparedReservedPaths)).toBe(true);
      return { kind: "veto", reason: `vetoed:${gateInput.call.id}` };
    };

    const result = await runTool(toolCall(tool.name, { value: "validated" }), makeContext(), new Map([[tool.name, tool]]), { gate });

    expect(result).toEqual({ content: "vetoed:test-vetoable", outcome: "error" });
    expect(coreExecuted).toBe(false);
  });

  it("passes immutable canonical descriptors to an allowing gate and executes core once", async () => {
    let executions = 0;
    const tool = {
      name: "write",
      action: "file_write" as const,
      description: "descriptor probe",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isConcurrencySafe: false,
      reservedPaths: (_input: RuntimeToolInput, cwd: string) => [`${cwd}/target.txt`],
      execute: async () => { executions++; return { content: "core", outcome: "ok" as const }; },
    } satisfies RuntimeTool;
    const gate: ToolExecutionGate = (gateInput) => {
      expect(gateInput.sessionId).toBe("test-session");
      expect(gateInput.executionCwd).toBe(makeContext().executionCwd);
      expect(gateInput.preparedReservedPaths).toEqual([`${makeContext().executionCwd}/target.txt`]);
      expect(Object.isFrozen(gateInput)).toBe(true);
      return { kind: "allow" };
    };
    const result = await runTool(toolCall("write", { path: "target.txt" }), makeContext({ sessionId: "test-session" }), new Map([[tool.name, tool]]), { gate });
    expect(result).toEqual({ content: "core", outcome: "ok" });
    expect(executions).toBe(1);
  });

  it("runs a read-side tool and its execution gate on the one path a mistyped path heals to", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "notes.txt"), "healed content");
    const gatedPaths: unknown[] = [];
    const gate: ToolExecutionGate = (gateInput) => {
      gatedPaths.push(gateInput.input.path);
      return { kind: "allow" };
    };

    const result = await runTool(toolCall("read", { path: "notes.txt:1-5" }), makeContext({ executionCwd: tmpDir }), testBaseTools(), { gate });

    expect(gatedPaths).toEqual(["src/notes.txt:1-5"]);
    expect(result.outcome).toBe("ok");
    expect(String(result.content)).toStartWith("[Path 'notes.txt' does not exist; showing 'src/notes.txt' instead.]\n");
    expect(String(result.content)).toContain("healed content");
  });

  it("resolves Flywheel's session-relative scratch paths for read and write when the project has no such path", async () => {
    const project = path.join(tmpDir, "project");
    const sessionDir = path.join(project, ".flywheel", "sessions", "s1");
    fs.mkdirSync(path.join(sessionDir, "scratch", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "scratch", "workflows", "review.workflow.yaml"), "id: review\n");
    const context = makeContext({ executionCwd: project, scratchDir: path.join(sessionDir, "scratch") });

    const read = await runTool(toolCall("read", { path: "scratch/workflows/review.workflow.yaml" }), context, testBaseTools());
    const written = await runTool(toolCall("write", { path: "scratch/workflows/draft.workflow.yaml", content: "id: draft\n" }), context, testBaseTools());

    expect(read.outcome).toBe("ok");
    expect(String(read.content)).toStartWith(`[Path 'scratch/workflows/review.workflow.yaml' does not exist in the execution directory; using '${path.join(sessionDir, "scratch", "workflows", "review.workflow.yaml")}' in the session directory instead.]\n`);
    expect(String(read.content)).toContain("id: review");
    expect(written.outcome).toBe("ok");
    expect(fs.readFileSync(path.join(sessionDir, "scratch", "workflows", "draft.workflow.yaml"), "utf8")).toBe("id: draft\n");
    expect(fs.existsSync(path.join(project, "scratch"))).toBe(false);
  });

  it("fails closed when the execution gate throws", async () => {
    let coreExecuted = false;
    const tool = {
      name: "gated",
      action: "shell_exec" as const,
      description: "gate failure probe",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => { coreExecuted = true; return { content: "core", outcome: "ok" as const }; },
    } satisfies RuntimeTool;
    const gate: ToolExecutionGate = () => { throw new Error("gate unavailable"); };

    const result = await runTool(toolCall(tool.name, {}), makeContext(), new Map([[tool.name, tool]]), { gate });

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Capability gate failed closed: gate unavailable");
    expect(coreExecuted).toBe(false);
  });

  it("reaches the execution gate only after policy and concurrency admission", async () => {
    const events: string[] = [];
    const tool = {
      name: "ordered",
      action: "shell_exec" as const,
      description: "ordering probe",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => { events.push("core"); return { content: "core", outcome: "ok" as const }; },
    } satisfies RuntimeTool;
    const gate: ToolConcurrencyGate = {
      acquire: async () => { events.push("permit"); return () => { events.push("release"); }; },
    };
    const executionGate: ToolExecutionGate = () => { events.push("module-gate"); return { kind: "veto", reason: "vetoed" }; };
    const prepared = prepareToolCall(toolCall(tool.name, {}), new Map([[tool.name, tool]]), admitEveryTool);

    const result = await Effect.runPromise(executeDispatchedTool({
      prepared,
      context: makeContext(),
      gate,
      toolExecutionGate: executionGate,
    }));

    expect(result).toEqual({ content: "vetoed", outcome: "error" });
    expect(events).toEqual(["permit", "module-gate", "release"]);

    // The shell's own policy refuses before any permit or gate,
    // and the result still carries the input repair note.
    events.length = 0;
    const wrapped = prepareToolCall(toolCall(bashDefinition.name, { parameters: { command: "git stash" } }), new Map([[bashDefinition.name, bashDefinition]]), admitEveryTool);
    const refused = await Effect.runPromise(executeDispatchedTool({
      prepared: wrapped, context: makeContext(), gate, toolExecutionGate: executionGate,
    }));
    expect(refused.outcome).toBe("error");
    expect(refused.content).toContain("`git stash` is disallowed");
    expect(String(refused.content)).toStartWith("Note: the arguments inside `parameters` were read as the arguments themselves.\n");
    expect(events).toEqual([]);
  });
});

describe("skill tool own validation through dispatch", () => {
  const body = "# legacy\n\nDo the legacy work.\n";
  const legacy: SkillDefinition = {
    id: "legacy-skill",
    name: "legacy-skill",
    trigger: "Use when the task is about legacy paging.",
    tags: [],
    relatedIds: [],
    dependencies: [],
    agents: [],
    modelInvocable: true,
    body,
    evidence: { bytes: body.length, sha256: "0".repeat(64), preview: body },
    packageIdentity: { sha256: "0".repeat(64), bytes: body.length },
    resources: [],
    source: { kind: "manifest", authority: "bundled", reach: "global", packageKey: "legacy-skill", files: new Map([["SKILL.md", body]]) },
  };
  const revision = publishSkillRevision(1, new Map([[legacy.id, legacy]]));
  const tools = new Map<string, RuntimeTool>(testBaseTools())
    .set("skill", createSkillTool({ treeCapabilities: () => true, availability: { skills: new Map(), availablePersonas: new Map() }, revision }));

  it("refuses an unknown parameter through the tool's own validation", async () => {
    const context = makeContext({ capabilityAccess: capabilityAccessHolding(["skills"]), capabilities: () => true });
    const result = await runTool(toolCall("skill", { action: "load", skill_id: "legacy-skill", topic: "pdf" }), context, tools);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("An unexpected parameter `topic` was provided");
  });
});

describe("capability admission of a model tool call", () => {
  const skillTools = (): Map<string, RuntimeTool> => {
    const body = "# gated\n\nDo the gated work.\n";
    const gated: SkillDefinition = {
      id: "gated-skill",
      name: "gated-skill",
      trigger: "Use when the task is about gating.",
      tags: [],
      relatedIds: [],
      dependencies: [],
      agents: [],
      modelInvocable: true,
      body,
      evidence: { bytes: body.length, sha256: "0".repeat(64), preview: body },
      packageIdentity: { sha256: "0".repeat(64), bytes: body.length },
      resources: [],
      source: { kind: "manifest", authority: "bundled", reach: "global", packageKey: "gated-skill", files: new Map([["SKILL.md", body]]) },
    };
    const revision = publishSkillRevision(1, new Map([[gated.id, gated]]));
    return new Map<string, RuntimeTool>(testBaseTools())
      .set("skill", createSkillTool({ treeCapabilities: () => true, availability: { skills: new Map(), availablePersonas: new Map() }, revision }));
  };

  /** Dispatches under a request whose captured module set turns `disabled` off. */
  const dispatch = async (call: ReturnType<typeof toolCall>, disabled: readonly ModuleId[], tools: ReadonlyMap<string, RuntimeTool>) =>
    executePreparedTool(prepareToolCall(call, tools, await requestAdmission(tools, composeFirstPartyModules(undefined, disabled))), makeContext({ capabilities: () => true }));

  it("admits a call whose capability the request enabled", async () => {
    const result = await dispatch(toolCall("skill", { action: "load", skill_id: "gated-skill" }), [], skillTools());
    expect(result.outcome).toBe("ok");
  });

  it("refuses a call whose registration needs a module that the request turned off, before the tool body runs", async () => {
    let executed = false;
    const probe: RuntimeTool = {
      name: "skill_manage", action: "ui_meta", description: "records that the body ran",
      inputSchema: { type: "object", properties: {} }, isConcurrencySafe: true,
      execute: async () => { executed = true; return { content: "ok", outcome: "ok" }; },
    };
    const result = await dispatch(toolCall("skill_manage", {}), ["skills"], new Map([[probe.name, probe]]));
    expect(result).toEqual({ content: "skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml", outcome: "error" });
    expect(executed).toBe(false);
  });

  it("refuses a call to a tool that the request's captured module set does not hold", async () => {
    const result = await dispatch(toolCall("skill", { action: "load", skill_id: "gated-skill" }), ["skills"], skillTools());
    expect(result).toEqual({ content: "Tool 'skill' is not registered in this request capability snapshot", outcome: "error" });
  });

  it("leaves a core tool alone", async () => {
    const result = await dispatch(toolCall("read", { path: "/nonexistent-capability-probe" }), ["skills", "learning", "subagents", "workflows"], new Map(testBaseTools()));
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Failed to read");
  });
});

describe("slim ToolDefinition with execute", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-slim-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  

  it("prepared dispatch runs definition.execute for all base tools", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const tools = testBaseTools();

    const bashResult = await runTool(toolCall("bash", { command: "echo registry-test" }), ctx, tools);
    expect(bashResult.outcome).toBe("ok");
    expect(bashResult.content).toContain("registry-test");

    const readResult2 = await runTool(toolCall("read", { path: "nonexistent.txt" }), ctx, tools);
    expect(readResult2.outcome).toBe("error");
    expect(readResult2.content).toContain("Failed to read");

    const handoffResult = await runTool(toolCall("handoff", { summary: "test" }), makeContext(), tools);
    expect(handoffResult.outcome).toBe("error");
    expect(handoffResult.content).toContain("no handoff capture");
  });

  // Every Anthropic route shows the model the handoff schema without format characters (tool-definition-text.ts).
  it("accepts a handoff whose key and value the model wrote without their format characters", async () => {
    const captured: { [key: string]: unknown }[] = [];
    const output = {
      summary: "What was done.",
      fields: { "ver\u200Bdict": { type: "enum", values: ["pass\u2066ed\u2069", "failed"], description: "The verdict." } },
    } as const satisfies OutputObject;
    const tools = new Map([["handoff", createHandoffTool({ schema: handoffToolSchemaFromOutput(compileOutput(output)) })]]);
    const ctx = makeContext({ handoff: { onContent: (content) => { captured.push(content); } } });

    const result = await runTool(toolCall("handoff", { summary: "done", verdict: "passed" }), ctx, tools);

    expect(result.outcome).toBe("ok");
    expect(captured).toEqual([{ summary: "done", "ver\u200Bdict": "pass\u2066ed\u2069" }]);
  });

  it("unknown tool returns explicit error with available tool names", async () => {
    const ctx = makeContext();
    const result = await runTool(toolCall("bogus_tool", {}), ctx, testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Unknown tool 'bogus_tool'");
    expect(result.content).toContain("bash");
    expect(result.content).toContain("handoff");
    expect(result.content).toContain("read");
    // The system prompt lists no tools, so the error names them itself.
    expect(result.content).not.toContain("system prompt");
  });

  it("bash execute validates input.command is a string", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await bashDefinition.execute({ command: 123 }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("'command' string");
  });

  it("testBaseTools returns only the self-contained static registry", () => {
    const tools = testBaseTools();
    expect(tools.size).toBe(10);
    const names = [...tools.keys()];
    expect(names).toEqual(expect.arrayContaining(["bash", "handoff", "papercut_dispose", "papercut_log", "read", "edit", "apply_patch", "write", "search", "list"]));
    // Dependency-bearing tools have no definition until the planner wires them.
    for (const granted of ["ask_user", "subagent", "workflow", "step"]) {
      expect(names).not.toContain(granted);
    }
    expect(names).not.toContain("text_search");
  });

  it("action selection resolves dependency-bearing tools through their identities", () => {
    const selected = selectedToolNames(runnerOptions(["task_subagent", "ask_user"]));
    expect(selected?.has("subagent")).toBe(true);
    expect(selected?.has("ask_user")).toBe(true);
  });

});
