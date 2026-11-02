import { expect, test } from "bun:test"
import { parseSchema } from "../../../helpers/schema-assertions.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { bindWorkflowAgentModels } from "../../../../src/orchestration/config/workflow-agent-models.js"
import { resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import { resolveWorkflowAgentRole } from "../../../../src/orchestration/config/role-selection.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import type { RoleSettings, RoleAssignmentSnapshot } from "../../../../src/orchestration/session/schemas.js"
import type { WorkflowLaunchAgentModels } from "../../../../src/infra/workflow-types.js"
import { createRoleAssignmentReader } from "../../../../src/orchestration/app-service/role-assignment-projection.js"
import { createRoleProtocolProjection } from "../../../../src/orchestration/app-service/role-protocol-projection.js"
import { sessionServingSelection } from "../../../../src/protocol/role-protocol-types.js"

async function publishedRoles(snapshot: RoleAssignmentSnapshot, capture: ReturnType<typeof roleCapture>, local: RoleAssignmentSnapshot = { defaults: {}, overrides: {} }) {
  const projection = createRoleProtocolProjection({
    manager: { subscribe: () => () => {} },
    publish: (input) => ({ ...input, position: 1, prevPosition: 0 }),
    readRoles: createRoleAssignmentReader({
      readSession: async () => ({ kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "build" }, roleAssignments: local }),
      inheritedRoles: async () => snapshot,
      capture: async () => capture,
      personas: async () => new Map([["build", { id: "explorer", roles: ["explorer"] }]]),
      workflowSeat: async () => ({ briefId: "demo.build", definitionId: "build" }),
      childRole: async () => undefined,
      userDataRoot: "/scratch",
    }),
  })
  try { return await projection.snapshot("workflow") } finally { await projection.dispose() }
}

const workflow = parseSchema(WorkflowDefinitionSchema, {
  id: "demo", name: "Demo", description: "One agent.",
  phases: [{ phase: "build", name: "Build", brief: "Build the task." }],
})
const resolvedAgents = resolveWorkflowAgents(workflow)
const agent = resolvedAgents.get("build")
if (!agent) throw new Error("The build phase must resolve")

test("a member's explicit pair stays local across run edits and agrees with its published serving seat", async () => {
  const capture = roleCapture(["local-model", "run-model", "next-model"])
  const local: RoleAssignmentSnapshot = { defaults: {}, overrides: {
    "brief.demo.build.at.build": { model: "local-model", effort: "low", providerOptions: { openai: { text_verbosity: "low" } } },
  } }
  for (const model of ["run-model", "next-model"]) {
    const inherited: RoleAssignmentSnapshot = { defaults: {}, overrides: { "brief.demo.build.at.build": { model, effort: "high" } } }
    const selected = resolveWorkflowAgentRole(agent, await resolveSessionRoles(local, capture, "/scratch", [], inherited))
    expect(selected).toMatchObject({ model: "local-model", effort: "low", providerOptions: { openai: { text_verbosity: "low" } } })
    const sibling = resolveWorkflowAgentRole(agent, await resolveSessionRoles({ defaults: {}, overrides: {} }, capture, "/scratch", [], inherited))
    expect(sibling).toMatchObject({ model, effort: "high" })
    const reading = await publishedRoles(inherited, capture, local)
    expect(sessionServingSelection(reading ?? undefined)).toMatchObject({ model: selected?.model, effort: selected?.effort })
    expect(reading?.serving?.slot).toEqual({ kind: "role", roleId: "brief.demo.build.at.build" })
  }
})

const cases: { readonly keys?: WorkflowLaunchAgentModels[string]; readonly stored: RoleSettings }[] = [
  { stored: {} },
  { keys: { model: "mid" }, stored: { "brief.demo.build.at.build.model": { model: "mid" } } },
  { keys: { effort: "high" }, stored: { "brief.demo.build.at.build.effort": { effort: "high" } } },
  { keys: { model: "lost-model", effort: "low" }, stored: { "brief.demo.build.at.build": { model: "lost-model", effort: "low" } } },
]
test.each(cases)("stores only authored launch fields: $keys", async ({ keys, stored }) => {
  const bound = await bindWorkflowAgentModels({
    workflow, resolvedAgents, agents: keys ? { build: keys } : undefined,
    userDataRoot: "/scratch", capture: roleCapture(["gpt-6.1-sol"]), personas: new Map(),
  })
  expect(bound.roles).toEqual(stored)
  expect(bound.models.pairs).toEqual([{ model: "gpt-6.1-sol", effort: keys?.model === "lost-model" ? "medium" : keys?.effort ?? "medium", definitionIds: ["build"] }])
  const replay = await resolveSessionRoles({ defaults: bound.roles, overrides: {} }, roleCapture(["claude-opus-5.5"]), "/scratch")
  expect(resolveWorkflowAgentRole(agent, replay)).toMatchObject({ model: "claude-opus-5.5", effort: keys?.effort === "high" ? "high" : "medium" })
})

test("resolves profile edits at resume, while an authored effort-only field stays fixed and is normalized", async () => {
  const bound = await bindWorkflowAgentModels({
    workflow, resolvedAgents, agents: { build: { effort: "max" } },
    userDataRoot: "/scratch", capture: roleCapture(["gpt-6.1-sol"]), personas: new Map(),
  })
  expect(bound.models.pairs).toEqual([{ model: "gpt-6.1-sol", effort: "high", definitionIds: ["build"] }])
  expect(bound.roles).toEqual({ "brief.demo.build.at.build.effort": { effort: "max" } })
  const replay = await resolveSessionRoles({ defaults: bound.roles, overrides: {} }, roleCapture(["next-model"], { "workflow-agent": { model: "next-model", effort: "low" } }), "/scratch")
  expect(resolveWorkflowAgentRole(agent, replay)).toMatchObject({ model: "next-model", effort: "high" })
})

test("previews an unauthored persona seat with the same coded pair as its worker", async () => {
  const definition = parseSchema(WorkflowDefinitionSchema, {
    id: "demo", name: "Demo", description: "One explorer.",
    phases: [{ phase: "explore", name: "Explore", brief: "Explore the task.", persona: "explorer" }],
  })
  const agents = resolveWorkflowAgents(definition)
  const capture = roleCapture(["gpt-6.1-sol", "gpt-6-luna"])
  const bound = await bindWorkflowAgentModels({
    workflow: definition, resolvedAgents: agents, userDataRoot: "/scratch", capture,
    personas: new Map([["explorer", {
      kind: "persona", name: "Explorer", description: "Explore.", maxTurns: 10,
      role: "explorer", systemPrompt: "Explore.", tools: [],
    }]]),
  })
  expect(bound.roles).toEqual({})
  expect(bound.models.pairs).toEqual([{ model: "gpt-6-luna", effort: "high", definitionIds: ["explore"] }])
  const worker = agents.get("explore")
  if (!worker) throw new Error("The explore phase must resolve")
  const roles = await resolveSessionRoles({ defaults: {}, overrides: {} }, capture, "/scratch", ["explorer"])
  expect(resolveWorkflowAgentRole(worker, roles, "explorer")).toMatchObject({ model: "gpt-6-luna", effort: "high" })
})

test("the viewer and request resolver follow the same live record, persona, brief, and workflow seats", async () => {
  const snapshot = { defaults: {}, overrides: {
    chat: { model: "chat-model", effort: "low" },
    "brief.demo.build": { model: "brief-model", effort: "low" },
  } }
  const capture = roleCapture(["chat-model", "brief-model", "persona-model", "record-model", "workflow-model"], {
    "workflow-agent": { model: "workflow-model", effort: "medium" },
    explorer: { model: "persona-model", effort: "high" },
  })
  for (const overrides of [snapshot.overrides, { ...snapshot.overrides, "brief.demo.build.at.build": { model: "record-model", effort: "low" } }]) {
    const roles = await resolveSessionRoles({ ...snapshot, overrides }, capture, "/scratch", ["explorer"])
    const serving = resolveWorkflowAgentRole(agent, roles, "explorer")
    const displayed = sessionServingSelection(await publishedRoles({ ...snapshot, overrides }, capture) ?? undefined)
    expect(serving?.model).toBe("brief.demo.build.at.build" in overrides ? "record-model" : "persona-model")
    expect(displayed).toMatchObject({ model: serving?.model, effort: serving?.effort })
  }
})

test.each(["model", "effort"] as const)("an authored %s fixes only that field and retains the selected model's options", async (field) => {
  const defaults: RoleSettings = field === "model"
    ? { "brief.demo.build.at.build.model": { model: "record-model" } }
    : { "brief.demo.build.at.build.effort": { effort: "low" } }
  const providerOptions = { openai: { text_verbosity: "low" as const } }
  const capture = roleCapture(["record-model", "persona-model", "workflow-model"], {
    "workflow-agent": { model: "workflow-model", effort: "medium" },
    explorer: { model: "persona-model", effort: "high", provider_options: providerOptions },
  })
  const roles = await resolveSessionRoles({ defaults, overrides: {} }, capture, "/scratch", ["explorer"])
  const selected = resolveWorkflowAgentRole(agent, roles, "explorer")
  expect(selected).toMatchObject(field === "model"
    ? { model: "record-model", effort: "medium" }
    : { model: "persona-model", effort: "low", providerOptions })
  const displayed = sessionServingSelection(await publishedRoles({ defaults, overrides: {} }, capture) ?? undefined)
  expect(displayed).toMatchObject({ model: selected?.model, effort: selected?.effort })
})

test.each([false, true])("does not refuse a launch with no model, pending=%s", async (pending) => {
  const bound = await bindWorkflowAgentModels({
    workflow, resolvedAgents, agents: { build: { model: "lost", effort: "low" } },
    userDataRoot: "/scratch", capture: roleCapture([], {}, pending), personas: new Map(),
  })
  expect(bound.models.pairs).toEqual([])
  expect(bound.models.unavailable).toEqual([{ definitionId: "build", reason: pending ? "access-pending" : "no-selection" }])
  expect(bound.roles).toEqual({ "brief.demo.build.at.build": { model: "lost", effort: "low" } })
})
