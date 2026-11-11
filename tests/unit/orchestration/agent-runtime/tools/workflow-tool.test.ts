import { describe, expect, it, mock } from "bun:test";
import { resolve } from "node:path";
import { asRecord } from "../../../../../src/infra/record.js";
import { fullAuthority } from "../../../../helpers/launch-authority.js";
import {
  createWorkflowToolCore,
  decorateWorkflowToolCall,
  type LaunchableWorkflowToolDeps,
  type ModelWorkflowLaunch,
} from "../../../../../src/orchestration/agent-runtime/tools/workflow-tool.js";
import { CANONICAL_WORKFLOW_FILE, createWorkflowTool } from "../../../../../src/orchestration/agent-runtime/tools/workflow.js";
import type { RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import {
  WORKFLOW_LAUNCH_RETRY_INSTRUCTION,
  type ResolveWorkflowLaunchTarget,
} from "../../../../../src/orchestration/workflow-host/launch-origin.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import { buildSystemPrompt } from "../../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { capabilityAccessHolding, makeContext as makeToolContext } from "./_fixtures.js";
import { promptOptions } from "../../../../helpers/prompt-capabilities.js";
import type { CapabilityCheck } from "../../../../../src/infra/capability-text.js";

// ---------------------------------------------------------------------------
// Task 2: createWorkflowTool
// ---------------------------------------------------------------------------

function makeContext() {
  return makeToolContext({ toolUseId: "tc_wf_1", modelRequestId: "req-wf-1", conversationId: "conv-1" });
}

/** A launched workflow that no one interrupts. */
const NOT_INTERRUPTED = { interruptedBy: () => undefined, observe: () => () => {} };
const AGENT_MODELS = { pairs: [{ model: "gpt-6.1-sol", effort: "medium", definitionIds: ["investigate"] }], personas: [] };

const SOURCE = { kind: "path", path: "scratch/workflows/debug.workflow.yaml" } as const;
const LAUNCH_TARGETS: ResolveWorkflowLaunchTarget = async () => ({ source: { kind: "path", path: SOURCE.path, definitionSha256: "a".repeat(64) }, name: "Debug" });

const AUTHORITY = fullAuthority(["reviewer"]);

const EVERY_CAPABILITY: CapabilityCheck = () => true;

function makeDeps(overrides?: Partial<LaunchableWorkflowToolDeps & { readonly capabilities: CapabilityCheck }>): LaunchableWorkflowToolDeps & { readonly capabilities: CapabilityCheck } {
  return {
    startWorkflow: async () =>
      ({ workflowId: "run-123", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS }),
    onRenderEvent: () => {},
    mode: "on",
    resolveLaunchTarget: LAUNCH_TARGETS,
    askUserAvailable: true,
    authority: AUTHORITY,
    sessionDir: "/session",
    executionCwd: "/project",
    capabilities: EVERY_CAPABILITY,
    ...overrides,
  };
}

describe("createWorkflowTool", () => {
  it("decorates render metadata with canonical workflow name and short summary", () => {
    const rendered = decorateWorkflowToolCall<{ id: string; name: string; input: RuntimeToolInput }>(
      {
        id: "tool-1",
        name: "workflow",
        input: {
          workflow_definition_id: "plan-implement",
          summary: "Activate On View refactor",
          description: "## Goal\nVery long prompt",
        },
      },
    );

    expect(rendered.input.workflow_display_name).toBe("Plan Implement");
    expect(rendered.input.summary).toBe("Activate On View refactor");
    expect(rendered.input.description).toBe("## Goal\nVery long prompt");
  });

  it("names a registered source by its workflow and a path source by its file, and still names a call recorded with the earlier top-level id", () => {
    const named = (input: RuntimeToolInput): string | undefined => {
      const name = decorateWorkflowToolCall<{ id: string; name: string; input: RuntimeToolInput }>({ id: "tool-1", name: "workflow", input: { ...input, description: "d" } }).input.workflow_display_name;
      return typeof name === "string" ? name : undefined;
    };

    expect(named({ source: { kind: "registered", definition_id: "debug" } })).toBe("Debug");
    expect(named({ source: { kind: "path", path: "scratch/workflows/survey-routes.workflow.yaml" } })).toBe("Survey Routes");
    expect(named({ source: { kind: "content", content: "id: survey-routes\nname: Survey routes\n" } })).toBe("Survey Routes");
    expect(named({ workflow_definition_id: "debug" })).toBe("Debug");
  });

  it("execute with a path source calls deps.startWorkflow with the stated intent", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: "run-1", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));

    await tool.execute(
      { source: SOURCE, summary: "Auth bug", description: "Fix the auth bug in login.ts" },
      makeContext(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toEqual({ kind: "path", path: resolve("/session", SOURCE.path) });
    expect(calls[0]!.summary).toBe("Auth bug");
    expect(calls[0]!.description).toBe("Fix the auth bug in login.ts");
  });

  it("forwards the model-facing cwd as launch intent", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: "run-1", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));

    await tool.execute(
      { source: SOURCE, description: "Fix it", cwd: "../child" },
      makeContext(),
    );

    expect(calls[0]?.launchCwd).toBe("../child");
  });

  it("forwards structured input as one object, and refuses input that is not one before calling the workflow host", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: `run-${calls.length}`, parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));
    const input = { items: [{ id: "a" }] };

    await tool.execute({ source: SOURCE, description: "Fix it", input }, makeContext());
    // A model that sends the object as its JSON text launches the same input.
    await tool.execute({ source: SOURCE, description: "Fix it", input: JSON.stringify(input) }, makeContext());
    await tool.execute({ source: SOURCE, description: "Fix it" }, makeContext());
    expect(calls.map((launch) => launch.input)).toEqual([input, input, undefined]);
    expect(calls[2]).not.toHaveProperty("input");

    for (const invalid of [[input], "not json", 7]) {
      const refused = await tool.execute({ source: SOURCE, description: "Fix it", input: invalid }, makeContext());
      expect(refused).toMatchObject({ outcome: "error", content: expect.stringContaining("requires 'input' to be one JSON object") });
    }
    expect(calls).toHaveLength(3);
  });

  it("advertises optional file input with a single object source schema", () => {
    const tool = createWorkflowTool(makeDeps());
    expect(tool.inputSchema).toMatchObject({ type: "object", properties: { input: { type: "object" } } });
    // The root stays one object schema (AGENTS.md section 8): the content
    // form is a third kind of source, and the handler enforces its field.
    for (const union of ["oneOf", "anyOf", "allOf"]) expect(tool.inputSchema).not.toHaveProperty(union);
    expect(tool.inputSchema.properties).toMatchObject({
      source: { type: "object", required: ["kind"], properties: { kind: { enum: ["path", "content"] }, content: { type: "string" } } },
    });
    expect(tool.inputSchema.required).not.toContain("input");
    expect(JSON.stringify(asRecord(tool.inputSchema.properties)?.input)).toContain("matches the file's `input` contract");
  });

  it("rejects an invalid cwd before calling the workflow host", async () => {
    const startWorkflow = mock(makeDeps().startWorkflow);
    const tool = createWorkflowToolCore(makeDeps({ startWorkflow }));

    const result = await tool.execute(
      { source: SOURCE, description: "Fix it", cwd: "" },
      makeContext(),
    );

    expect(result.outcome).toBe("error");
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  // The capability boundary that the call holds bounds the workflow's agents (PI-AGENT-121).
  it("attests the call context and the caller's capability boundary so the host can stamp a trusted model origin", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowTool(makeDeps({
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: "run-1", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));
    const capabilityAccess = capabilityAccessHolding(["workflows"]);

    await tool.execute(
      { source: SOURCE, description: "x" },
      makeToolContext({ toolUseId: "tc_xyz", conversationId: "conv-9", capabilityAccess }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toEqual({
      conversationId: "conv-9",
      toolUseId: "tc_xyz",
      confirmation: { kind: "absent" },
      authority: AUTHORITY,
      capabilityAccess,
    });
  });

  it("refuses a call with no durable session context", async () => {
    const tool = createWorkflowToolCore(makeDeps());

    const result = await tool.execute({ source: SOURCE, description: "x" }, { toolUseId: "tc_1" });

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("durable session context");
  });

  it("launches a path in the workflow directory by its absolute path and refuses a source that lacks the field its kind requires", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowToolCore(makeDeps({
      sessionDir: "/session",
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: "run-1", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));

    await tool.execute({ source: { kind: "path", path: "scratch/workflows/survey.workflow.yaml" }, description: "Survey" }, makeContext());
    const noPath = await tool.execute({ source: { kind: "path" }, description: "Survey" }, makeContext());
    const noContent = await tool.execute({ source: { kind: "content", path: "a.workflow.yaml" }, description: "Survey" }, makeContext());
    const noDirectory = await createWorkflowToolCore(makeDeps({ sessionDir: undefined })).execute({ source: { kind: "content", content: "id: survey\n" }, description: "Survey" }, makeContext());
    const noSource = await tool.execute({ workflow_definition_id: "debug", description: "Survey" }, makeContext());

    expect(calls.map((call) => call.source)).toEqual([{ kind: "path", path: resolve("/session", "scratch/workflows/survey.workflow.yaml") }]);
    expect(noPath).toMatchObject({ outcome: "error", content: "A source of kind path requires source.path, the workflow file to launch." });
    expect(noContent).toMatchObject({ outcome: "error", content: "A source of kind content requires source.content, the YAML text of the workflow file to save and launch." });
    expect(noDirectory).toMatchObject({ outcome: "error", content: "This session has no scratch directory, so it cannot launch a workflow file." });
    expect(noSource).toMatchObject({ outcome: "error", content: expect.stringContaining("requires 'source'") });
  });

  it("reports the file, its definition hash, the verifier result, the worst-case attempt count, and each warning of a launched workflow file", async () => {
    const launched = (warnings: readonly string[]) => createWorkflowToolCore(makeDeps({
      sessionDir: "/session",
      startWorkflow: async () => ({
        workflowId: "run-file", parentSessionId: "parent",
        done: Promise.resolve({ status: "completed" as const, content: "done" }),
        terminate: async () => {},
        interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS,
        workflowFile: { path: "/session/scratch/workflows/survey.workflow.yaml", definitionSha256: "f".repeat(64), verification: "partially_proved", verificationUncertainties: ["runtime_handoff_values", "runtime_map_width"], worstCaseAttempts: 7, warnings },
      }),
    }));
    const call = { source: { kind: "path", path: "scratch/workflows/survey.workflow.yaml" }, description: "Survey" }

    const clean = await launched([]).execute(call, makeContext());
    const warned = await launched(["development-only: this key is retired and does nothing; remove it", "flow: bounded_graph_exploration: States beyond the bound were not proved."]).execute(call, makeContext());

    expect(clean.content).toContain(`It runs the workflow file /session/scratch/workflows/survey.workflow.yaml with definition hash ${"f".repeat(64)}. The verifier result is partially_proved (leaves runtime handoff values, runtime map width unproved), and the run can queue at most 7 attempts.`);
    expect(clean.content).not.toContain("warning");
    expect(warned.content).toContain("The launch warns about 2 problems that do not stop the run; fix them in the file before you launch it again:\n- development-only: this key is retired and does nothing; remove it\n- flow: bounded_graph_exploration: States beyond the bound were not proved.\n");
  });

  it("states the model and effort that each agent of a launched workflow starts on, with the agents that share a pair together", async () => {
    const result = await createWorkflowToolCore(makeDeps({
      startWorkflow: async () => ({
        workflowId: "run-pairs", parentSessionId: "parent",
        done: Promise.resolve({ status: "completed" as const, content: "done" }),
        terminate: async () => {},
        interruption: NOT_INTERRUPTED,
        stepModels: { pairs: [{ model: "gpt-6.1-sol", effort: "medium", definitionIds: ["implement", "scan"] }, { model: "claude-sonnet-4.6", effort: "low", definitionIds: ["explore"] }], personas: [] },
      }),
    })).execute({ source: SOURCE, description: "Fix it" }, makeContext());

    expect(result.content).toContain("The agents run on gpt-6.1-sol at medium effort for implement, scan; claude-sonnet-4.6 at low effort for explore. Open");
    expect(result.content).not.toContain("check prompt");
  });

  it("refuses a named source without starting a workflow", async () => {
    const tool = createWorkflowToolCore(makeDeps());

    const result = await tool.execute(
      { source: { kind: "registered", definition_id: "nonexistent" }, description: "anything" },
      makeContext(),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("requires 'source' with kind 'path'");
  });

  it("execute returns human-readable success message including workflow ID when startWorkflow succeeds", async () => {
    const tool = createWorkflowToolCore(makeDeps());

    const result = await tool.execute(
      { source: SOURCE, description: "Fix the auth bug" },
      makeContext(),
    );

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("workflow run-123");
    expect(result.deferCompletion).toBe(true);
  });

  it("directs inspection to the activity row and follow-up to the parent", async () => {
    const tool = createWorkflowToolCore(makeDeps());

    const result = await tool.execute(
      { source: SOURCE, description: "Complete the requested work" },
      makeContext(),
    );

    expect(result.content).toContain("Open this activity row");
    expect(result.content).toContain("The process tool takes this workflow id for its progress, an interrupt, a resume, or a stop.");
    expect(result.content).toContain("To answer one agent, use that agent's session id from workflow status.");
    expect(result.content).toContain("Continue follow-up conversation in this chat");
    expect(result.content).toContain("completed workflow is read-only");
    expect(result.content).not.toContain("session switcher");
    expect(result.content).not.toContain("Keep this chat open");
  });

  it("execute returns outcome error with the error message when startWorkflow returns { error }", async () => {
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async () => ({ error: "No workflow runner available" }),
    }));

    const result = await tool.execute(
      { source: SOURCE, description: "Implement something" },
      makeContext(),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("No workflow runner available");
    expect(result.content).not.toContain("Keep this chat open");
  });

  it("startWorkflow rejection (thrown error) propagates — no try/catch in execute", async () => {
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async () => { throw new Error("controller exploded"); },
    }));

    await expect(
      tool.execute(
        { source: SOURCE, description: "Fix something" },
        makeContext(),
      ),
    ).rejects.toThrow("controller exploded");
  });

  it("launches workflow files and leaves the file reference to the workflow-authoring skill", () => {
    const toolDescription = createWorkflowTool(makeDeps()).description;
    expect(toolDescription).toContain("Write a workflow file for substantive work");
    expect(toolDescription).toContain('Launch a workflow file that you write in one call: workflow({ source: { kind: "content", content }, summary, description, input }). Flywheel saves the content as scratch/workflows/<id>.workflow.yaml in this session\'s directory, replacing a file of that name, and launches the saved file. Name a saved file with { kind: "path", path } to launch it again or after you edit it.');
    expect(toolDescription).toContain("The launch decodes, admits, and verifies the file before any agent starts; a refused launch starts nothing, keeps the saved file, and lists each problem.");
    expect(toolDescription).toContain("Before you write a workflow file, load the `workflow-authoring` skill.");
    // The prompt shows one canonical file. The grammar, the reducers, the
    // limits, and the method live in the skill, which a chat loads only when
    // it writes a file.
    expect(toolDescription).toContain(CANONICAL_WORKFLOW_FILE);
    expect(toolDescription.split("\nphases:\n")).toHaveLength(2);
    // The description field states how to write the description, so the
    // prompt does not repeat it.
    expect(toolDescription.trimEnd().endsWith(`${CANONICAL_WORKFLOW_FILE.split("\n").at(-1)}`)).toBe(true);
    for (const reference of ["coverage", "quorum", "while:", "repeat:", "max_attempts", "Effective descriptions", "There are three tiers of execution", "Default to in-process work"]) {
      expect(toolDescription).not.toContain(reference);
    }
    expect(toolDescription).toContain("as subagents instead.");
    // Without the subagent tool the description sends no agent to it.
    expect(createWorkflowTool(makeDeps({ capabilities: (term) => term !== "subagent" })).description).not.toContain("subagent");

  });

  it("ASK requires confirmation_id in its advertised schema and forwards the supplied id", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowTool(makeDeps({
      mode: "ask",
      startWorkflow: async (launch) => {
        calls.push(launch);
        return { workflowId: "run-1", parentSessionId: "parent", done: Promise.resolve({ status: "completed" as const, content: "done" }), terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS };
      },
    }));
    const properties = asRecord(tool.inputSchema.properties);
    const required = tool.inputSchema.required;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties) || !Array.isArray(required)) throw new Error("workflow schema is malformed");
    expect(properties.confirmation_id).toBeDefined();
    expect(required).toContain("confirmation_id");

    const approved = await tool.execute({ source: SOURCE, summary: "s", description: "d", confirmation_id: "q-7" }, makeContext());
    expect(approved.outcome).toBe("ok");
    expect(calls[0]!.model.confirmation).toEqual({ kind: "supplied", confirmationId: "q-7" });
  });

  it("ON omits confirmation_id from the advertised schema, yet a call that carries one reaches the launch authority instead of a schema error", async () => {
    const calls: ModelWorkflowLaunch[] = [];
    const tool = createWorkflowTool(makeDeps({
      mode: "on",
      startWorkflow: async (launch) => {
        calls.push(launch);
        return {
          error: "Workflows does not require approval in this session, so confirmation_id is not accepted.",
          recovery: "Call workflow again without it.",
        };
      },
    }));
    const properties = asRecord(tool.inputSchema.properties);
    const required = tool.inputSchema.required;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties) || !Array.isArray(required)) throw new Error("workflow schema is malformed");
    expect(properties.confirmation_id).toBeUndefined();
    expect(required).not.toContain("confirmation_id");

    const input = { source: SOURCE, summary: "s", description: "d", confirmation_id: "q-7" };
    const refused = await executePreparedTool(
      prepareToolCall({ id: "tc_wf_1", name: "workflow", input }, new Map([[tool.name, tool]])),
      makeToolContext({ toolUseId: "tc_wf_1", modelRequestId: "req-wf-1", conversationId: "conv-1", capabilityAccess: capabilityAccessHolding(["workflows"]) }),
    );

    expect(calls.map((call) => call.model.confirmation)).toEqual([{ kind: "supplied", confirmationId: "q-7" }]);
    expect(refused).toMatchObject({
      outcome: "error",
      content: "Workflows does not require approval in this session, so confirmation_id is not accepted. Call workflow again without it.",
    });
  });

  it("names this session's workflow directory by its place in the scratchpad, so every session shares the guideline bytes", () => {
    const guidelines = (sessionDir?: string) => createWorkflowToolCore(makeDeps({ sessionDir })).promptGuidelines.join("\n");

    expect(guidelines("/home/a/.flywheel/sessions/s1")).toContain("This session's workflow directory is `workflows` inside its scratchpad directory, where a content launch saves its file. Edit a saved file by its absolute path, because a relative scratch/ path reaches this directory only when the project has no scratch entry of its own, and launch it by that same path.");
    // Guidelines render in the stable tier, which every session of the role reads from the prompt cache.
    expect(guidelines("/home/a/.flywheel/sessions/s1")).toBe(guidelines("/home/b/.flywheel/sessions/s2"));
    // A session without a scratch directory launches no file.
    expect(guidelines()).not.toContain("workflow directory is");
  });

  it("gives the agent every located problem and its recovery on a line of its own, and the card a one-line count", async () => {
    const error = "the workflow file scratch/workflows/x.workflow.yaml is unavailable: the file is not valid."
    const problems = ["scratch/workflows/x.workflow.yaml: Step 1, flow.1: references unknown step \"publish\"", "scratch/workflows/x.workflow.yaml: Step 2, flow.2: names no step"]
    const tool = createWorkflowTool(makeDeps({ sessionDir: "/session", startWorkflow: async () => ({ error, problems, recovery: "Load the `workflow-authoring` skill if you have not, fix the file, and launch it again." }) }))

    const refused = await tool.execute({ source: { kind: "path", path: "scratch/workflows/x.workflow.yaml" }, summary: "s", description: "d" }, makeToolContext({ toolUseId: "tc_wf_1", modelRequestId: "req-wf-1", conversationId: "conv-1" }))

    expect(refused).toMatchObject({
      outcome: "error",
      content: `${error}\n- ${problems[0]}\n- ${problems[1]}\nLoad the \`workflow-authoring\` skill if you have not, fix the file, and launch it again.`,
      details: { agentFailure: { message: "the workflow file scratch/workflows/x.workflow.yaml is unavailable: the file is not valid (2 problems)." } },
    })
  })

  it("puts the recovery of a reason that spans lines on a line of its own, with no problem list", async () => {
    const error = "The workflow input does not match its contract:\n- files: is required"
    const tool = createWorkflowTool(makeDeps({ sessionDir: "/session", startWorkflow: async () => ({ error, recovery: "Fix the input, and launch it again." }) }))

    const refused = await tool.execute({ source: { kind: "path", path: "scratch/workflows/x.workflow.yaml" }, summary: "s", description: "d" }, makeToolContext({ toolUseId: "tc_wf_2", modelRequestId: "req-wf-2", conversationId: "conv-1" }))

    expect(refused).toMatchObject({ outcome: "error", content: `${error}\nFix the input, and launch it again.`, details: { agentFailure: { message: error } } })
  })

  it("refuses every launch with the reason on a workflow card that offers no retry advice", async () => {
    const tool = createWorkflowTool(makeDeps({
      mode: "ask",
      startWorkflow: async () => ({ error: "Confirmation q-7 was already used, and one approval launches one workflow.", recovery: WORKFLOW_LAUNCH_RETRY_INSTRUCTION }),
    }));

    const reused = await tool.execute({ source: SOURCE, summary: "s", description: "d", confirmation_id: "q-7" }, makeContext());
    const unknown = await tool.execute({ source: { kind: "registered", definition_id: "missing" }, summary: "s", description: "d", confirmation_id: "q-7" }, makeContext());

    expect(reused).toMatchObject({
      outcome: "error",
      content: `Confirmation q-7 was already used, and one approval launches one workflow. ${WORKFLOW_LAUNCH_RETRY_INSTRUCTION}`,
      details: { agentFailure: { title: "Workflow not started", message: "Confirmation q-7 was already used, and one approval launches one workflow." } },
    });
    expect(unknown).toMatchObject({
      outcome: "error",
      content: "The workflow tool requires 'source' with kind 'path' and a path, or kind 'content' and content.",
      details: { agentFailure: { title: "Workflow not started", message: "The workflow tool requires 'source' with kind 'path' and a path, or kind 'content' and content." } },
    });
    for (const result of [reused, unknown]) {
      expect(JSON.stringify(result.details)).not.toMatch(/retry/i);
    }
  });

  it("gives launch guidance for only the active workflow mode", () => {
    const askPrompt = renderSystemPrompt(buildSystemPrompt(promptOptions({ tools: [createWorkflowTool(makeDeps({ mode: "ask" }))], promptKind: "chat" })));
    const onPrompt = renderSystemPrompt(buildSystemPrompt(promptOptions({ tools: [createWorkflowTool(makeDeps({ mode: "on" }))], promptKind: "chat" })));

    expect(askPrompt).toContain("Workflows needs the user's typed approval for every launch you start.");
    expect(askPrompt).toContain("decision: { workflow_launch:");
    expect(askPrompt).toContain("pass it as `confirmation_id` when you call `workflow`");
    expect(askPrompt).not.toContain("Workflows is On for this session");
    expect(onPrompt).toContain("Workflows is On for this session");
    expect(onPrompt).toContain("Call `workflow` directly without asking for workflow-launch confirmation");
    expect(onPrompt).not.toContain("Workflows needs the user's typed approval");
    expect(onPrompt).not.toContain("confirmation_id");
  });

  it("leaves the first-draft audit to the first-draft commitment of the chat body in every chat configuration", () => {
    const skill = { name: "skill", action: "ui_meta" as const, description: "Load a skill package." };
    const workflow = createWorkflowTool(makeDeps({ mode: "ask" }));
    const chat = { promptKind: "chat" as const, chatHost: { communication: true as const } };
    const prompts = [
      renderSystemPrompt(buildSystemPrompt(promptOptions({ ...chat, tools: [workflow, skill], skills: ["code-review"] }))),
      renderSystemPrompt(buildSystemPrompt(promptOptions({ ...chat, tools: [skill], skills: ["code-review"] }))),
      renderSystemPrompt(buildSystemPrompt(promptOptions({ ...chat, tools: [workflow], skills: [] }))),
    ];

    for (const prompt of prompts) expect(prompt.match(/\*\*Every change is a first draft\.\*\*/g)).toHaveLength(1);
    for (const prompt of [prompts[0]!, prompts[2]!]) {
      expect(prompt.match(/a workflow handoff carries them in its declared output/g)).toHaveLength(1);
    }
    // Without a delegation tool the chat has no delegated result to read deviations from.
    expect(prompts[1]).toContain("Record your own deviations from that intent as you work.");
    expect(prompts[1]).not.toContain("a workflow handoff carries them");
    expect(workflow.promptGuidelines?.join("\n")).not.toContain("first draft");
    expect(workflow.description).not.toContain("first draft");
  });

  it("keeps conversational settlement policy out of workflow guidance", () => {
    const guidelinesText = createWorkflowToolCore(makeDeps()).promptGuidelines.join("\n");

    expect(guidelinesText).toContain("checkpoint's approved Design intent and Decisions");
    expect(guidelinesText).toContain("do not copy them into the launch description or briefs");
    // Eligibility belongs to each workflow's use_when; the generic guideline
    // does not restate when an implementation workflow may launch.
    expect(guidelinesText).not.toContain("resolve every open question");
    expect(guidelinesText).not.toContain("analyze available data");
    expect(guidelinesText).not.toContain("Agreement is not sticky");
    expect(guidelinesText).not.toContain("voids the settlement");
    expect(guidelinesText).not.toContain("fresh plain affirmative");
  });

  it("tells the parent that a message to its workflow child reaches the reading agent and every later agent", () => {
    const guidelinesText = createWorkflowToolCore(makeDeps()).promptGuidelines.join("\n");

    expect(guidelinesText).toContain("After launch, target your workflow id in message_session to add direction to its request.");
    expect(guidelinesText).toContain("Put a change to fixed intent under the heading Design intent");
    // The agent-session rule lives in the message_session description, the reply-wait rule on its wait field, and the
    // worktree rule in the system prompt (ARCH-CONTEXT-035).
    expect(guidelinesText).not.toContain("A message to an agent session reaches only that agent");
    expect(guidelinesText).not.toContain("takes no reply wait");
    expect(guidelinesText).not.toContain("Git worktree");
  });

  it("gives no workflow catalog in prompt guidelines", () => {
    const tool = createWorkflowToolCore(makeDeps());

    expect(tool.promptGuidelines).toBeDefined();
    expect(tool.promptGuidelines.length).toBeGreaterThanOrEqual(1);
    const guidelinesText = tool.promptGuidelines.join("\n");
    expect(guidelinesText).not.toContain("Available workflows");
  });

  it("when the publish boundary fails before runner start, no tool result or agent link is emitted", async () => {
    const renderedEvents: Array<{ type: string }> = [];
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async () => ({ error: "Config error: invalid workflow" }),
      onRenderEvent: (event) => { renderedEvents.push({ type: event.type }); },
    }));

    const result = await tool.execute(
      { source: SOURCE, description: "Fix the bug" },
      makeContext(),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Config error");
    expect(renderedEvents).toEqual([]);
  });

});

function findToolResult(events: RuntimeEvent[]): Extract<RuntimeEvent, { type: "tool.result.recorded" }> | undefined {
  return events.find((e): e is Extract<RuntimeEvent, { type: "tool.result.recorded" }> => e.type === "tool.result.recorded");
}

describe("workflow tool completion delivery", () => {
  it("leaves completed workflow settlement to the reconciler", async () => {
    const renderedEvents: RuntimeEvent[] = [];
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async () => ({
        workflowId: "run-ok", parentSessionId: "parent",
        done: Promise.resolve({ status: "completed" as const, content: "workflow finished cleanly" }),
        terminate: async () => {},
        interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS,
      }),
      onRenderEvent: (event) => renderedEvents.push(event),
    }));

    await tool.execute({ source: SOURCE, description: "Do the thing" }, makeContext());
    await Promise.resolve();

    expect(findToolResult(renderedEvents)).toBeUndefined();
  });

  it("publishes no direct result when workflow done rejects", async () => {
    const renderedEvents: RuntimeEvent[] = [];
    const rejected = Promise.reject(new Error("host crashed"));
    rejected.catch(() => {});
    const tool = createWorkflowToolCore(makeDeps({
      startWorkflow: async () => ({ workflowId: "run-reject", parentSessionId: "parent", done: rejected, terminate: async () => {}, interruption: NOT_INTERRUPTED, stepModels: AGENT_MODELS }),
      onRenderEvent: (event) => renderedEvents.push(event),
    }));

    await tool.execute({ source: SOURCE, description: "Do the thing" }, makeContext());
    await new Promise((settle) => setTimeout(settle, 0));

    expect(findToolResult(renderedEvents)).toBeUndefined();
  });

});
