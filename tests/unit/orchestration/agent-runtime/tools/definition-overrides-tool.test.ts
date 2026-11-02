import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { createDefinitionOverridesTool } from "../../../../../src/orchestration/agent-runtime/tools/definition-overrides.js"
import { makeContext } from "./_fixtures.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import type { PreparedOverrideResolution } from "../../../../../src/workflows/definitions/override-staleness.js"
import { createManagedPackageWrites } from "../../../../../src/orchestration/modules/learning/managed-package-writes.js"
import { loadSkillDefinitions } from "../../../../../src/workflows/skills.js"
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js"
import { reconcilePendingAudits } from "../../../../../src/orchestration/modules/learning/learning-journal.js"

test("refuses unsafe complete package keys before preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "definition-overrides-tool-"))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, "escape")
  await writeFile(outside, "safe")
  let preparations = 0
  const service = {
    available: () => true,
    list: async () => ({ overrides: [], diagnostics: [] }),
    diff: async () => ({ version: 1 as const, files: [], omissions: [] }),
    prepare: async () => { preparations += 1; throw new Error("must not prepare") },
    apply: async () => {},
    refresh: async () => {},
    subscribe: () => () => {},
    proposal: () => undefined,
    finalizeSkillPublication: async () => {},
  }
  const tool = createDefinitionOverridesTool({ service, askUserAvailable: true })

  for (const unsafe of ["../escape", ".base/SKILL.md"]) {
    await expect(tool.execute({
      action: "rebase",
      path: join(root, "demo", "SKILL.md"),
      merged_files: { "SKILL.md": "skill", [unsafe]: "hostile" },
    }, makeContext())).rejects.toThrow()
  }

  expect(preparations).toBe(0)
  expect(await readFile(outside, "utf8")).toBe("safe")
})

test("keeps inspection available but refuses resolution without Ask User, and names message_session only to a child that has it", async () => {
  const prepared = {
    preparationId: "prepared-1",
    action: "keep-mine" as const,
    target: {
      kind: "single-file" as const,
      family: "persona" as const,
      id: "demo",
      path: "/project/demo.md",
      layer: "project" as const,
      overrideIdentity: "old",
      currentDefaultIdentity: "new",
    },
  };
  const toolFor = (parentChannel: boolean) => createDefinitionOverridesTool({
    service: {
      available: () => true,
      subscribe: () => () => {},
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => ({ version: 1 as const, files: [], omissions: [] }),
      prepare: async () => prepared,
      apply: async () => {},
      refresh: async () => {},
      proposal: () => prepared,
      finalizeSkillPublication: async () => {},
    },
    askUserAvailable: false,
    parentChannel,
  });
  const tool = toolFor(true);

  expect((await tool.execute({ action: "list" }, makeContext())).outcome).toBe("ok");
  const result = await tool.execute({ action: "keep-mine", path: prepared.target.path }, makeContext());
  expect(result.outcome).toBe("error");
  expect(result.content).toContain("requires the Ask User capability");
  expect(result.content).toContain("In a child session, message your parent with message_session");
  expect(result.content).not.toContain("Ask with ask_user");

  // A child without message_session has no parent that can answer, so it decides alone.
  const alone = toolFor(false);
  const refused = await alone.execute({ action: "keep-mine", path: prepared.target.path }, makeContext());
  expect(refused.content).toContain("In a child session, no parent can answer during this run: leave the override unresolved, decide on your own judgment, and state in your handoff");
  expect(`${alone.description} ${refused.content}`).not.toContain("message_session");
});

test("does not let Learning Review acquire definition override authority", async () => {
  let preparations = 0
  const tool = createDefinitionOverridesTool({
    service: {
      available: () => true,
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => ({ version: 1 as const, files: [], omissions: [] }),
      prepare: async () => { preparations += 1; throw new Error("must not prepare") },
      apply: async () => {},
      refresh: async () => {},
      subscribe: () => () => {},
      proposal: () => undefined,
      finalizeSkillPublication: async () => {},
    },
    packages: {
      review: true,
      check: () => { throw new Error("must not plan publication") },
      applyGlobal: async () => { throw new Error("must not apply global publication") },
      applyProject: async () => { throw new Error("must not apply project publication") },
    },
    askUserAvailable: true,
  })

  const result = await tool.execute({ action: "adopt-default", path: "/project/skill/SKILL.md", confirmation_id: "answer-1" }, makeContext())
  expect(result.outcome).toBe("error")
  expect(result.content).toContain("cannot resolve definition overrides")
  expect(preparations).toBe(0)
})

test.each([
  { reach: "global", auditPending: false }, { reach: "project", auditPending: false },
  { reach: "global", auditPending: true }, { reach: "project", auditPending: true },
] as const)("skill override publication retains approval and durable attribution: %j", async ({ reach, auditPending }) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "override-publication-")))
  const projectRoot = join(root, "project")
  const userDataRoot = join(root, "account")
  const skillRoot = reach === "global" ? join(userDataRoot, "skills") : join(projectRoot, ".flywheel", "skills")
  const skillPath = join(skillRoot, "demo", "SKILL.md")
  await mkdir(join(skillRoot, "demo"), { recursive: true })
  await mkdir(projectRoot, { recursive: true })
  await writeFile(skillPath, "---\ndescription: Use for demonstrations.\nmanaged: flywheel\n---\nBody.\n")
  const store = createSqliteEventStore(join(root, "store", "flywheel.sqlite"))
  const writer = createSessionFactWriter({ sessionId: "override-session", writer: asAsyncEventWriter(store) })
  const prepared: PreparedOverrideResolution = {
    preparationId: "prepared-skill",
    action: "adopt-default",
    target: { kind: "skill-package", family: "skill", id: "demo", path: skillPath, layer: "project", reach, overridePackageIdentity: "old", currentDefaultPackageIdentity: "new" },
  }
  const publications: string[] = []
  const tool = createDefinitionOverridesTool({
    askUserAvailable: true,
    service: {
      available: () => true,
      subscribe: () => () => {},
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => ({ version: 1, files: [], omissions: [] }),
      prepare: async () => prepared,
      proposal: () => prepared,
      apply: async () => { throw new Error("Skill publication must use the package authority") },
      refresh: async () => {},
      finalizeSkillPublication: async () => { publications.push("finalized") },
    },
    packages: createManagedPackageWrites({
      origin: { kind: "agent", sessionId: "override-session" },
      store: asAsyncEventReadSurface(store), sessionId: "override-session", userDataRoot,
      registry: () => publishSkillRevision(1, loadSkillDefinitions({ roots: [{ authority: "external", dir: skillRoot, reach }] }).skills),
    }),
  })
  const publicationWriter: typeof writer = auditPending ? { ...writer, record: (fact) => fact.type === "skill.written" ? Promise.resolve(null) : writer.record(fact) } : writer
  const context = { ...makeContext(), projectRoot, sessionId: "override-session", toolUseId: "override-call", sessionEventWriter: publicationWriter }
  const input = { action: "adopt-default", path: prepared.target.path }
  try {
    const first = await tool.execute(input, context)
    expect(first.outcome).toBe("error")
    expect(first.content).toContain('definition_override: { preparation_id: "prepared-skill" }')
    expect(first.content).not.toContain("proposal_id")
    expect(publications).toEqual([])
    expect(existsSync(skillPath)).toBe(true)
    expect((await tool.execute({ ...input, confirmation_id: "missing" }, context)).outcome).toBe("error")
    expect(publications).toEqual([])
    await writer.record({
      type: "agent_input.requested", version: 3, actor: "agent",
      payload: {
        interactionId: "approval", conversationId: "conversation", toolUseId: "approval",
        request: [{ question: "Resolve?", choices: [{ kind: "option", choiceId: "approve", label: "Approve" }], multiSelect: false }],
        decision: { kind: "definition_override", preparationId: prepared.preparationId, question: "Resolve?", approve: { choiceId: "approve", label: "Approve" }, reject: { choiceId: "reject", label: "Reject" } },
      },
    })
    await writer.record({ type: "agent_input.answered", version: 3, actor: "user", payload: { interactionId: "approval", answers: { "Resolve?": { kind: "choice", selections: [{ choiceId: "approve" }], text: "Approve" } } } })
    const published = await tool.execute({ ...input, confirmation_id: "approval" }, context)
    expect(published.outcome).toBe(auditPending ? "error" : "ok")
    if (auditPending) {
      expect(published.content).toContain("audit record is pending recovery")
      expect(store.read({ types: ["skill.written"], afterPosition: 0 })).toHaveLength(0)
      expect(await reconcilePendingAudits({ storeDir: skillRoot, workspace: projectRoot, reader: asAsyncEventReadSurface(store), writer })).toBe(1)
    }
    expect(publications).toEqual(["finalized"])
    expect(existsSync(skillPath)).toBe(false)
    const facts = store.read({ types: ["skill.written"], afterPosition: 0 })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.payload).toMatchObject({ reach, name: "demo", origin: { kind: "agent", sessionId: "override-session" } })
    expect((await tool.execute({ ...input, confirmation_id: "approval" }, context)).outcome).toBe("error")
    expect(publications).toEqual(["finalized"])
  } finally {
    writer.dispose()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses an unmanaged skill override before it asks and before it spends an approval", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "override-unmanaged-")))
  const projectRoot = join(root, "project")
  const skillRoot = join(projectRoot, ".flywheel", "skills")
  const skillPath = join(skillRoot, "demo", "SKILL.md")
  await mkdir(join(skillRoot, "demo"), { recursive: true })
  await writeFile(skillPath, "---\ndescription: Use for demonstrations.\n---\nBody.\n")
  const store = createSqliteEventStore(join(root, "store", "flywheel.sqlite"))
  const writer = createSessionFactWriter({ sessionId: "override-session", writer: asAsyncEventWriter(store) })
  const prepared: PreparedOverrideResolution = {
    preparationId: "prepared-skill",
    action: "adopt-default",
    target: { kind: "skill-package", family: "skill", id: "demo", path: skillPath, layer: "project", reach: "project", overridePackageIdentity: "old", currentDefaultPackageIdentity: "new" },
  }
  const tool = createDefinitionOverridesTool({
    askUserAvailable: true,
    service: {
      available: () => true,
      subscribe: () => () => {},
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => ({ version: 1, files: [], omissions: [] }),
      prepare: async () => prepared,
      proposal: () => prepared,
      apply: async () => { throw new Error("Skill publication must use the package authority") },
      refresh: async () => {},
      finalizeSkillPublication: async () => {},
    },
    packages: createManagedPackageWrites({
      origin: { kind: "agent", sessionId: "override-session" },
      store: asAsyncEventReadSurface(store), sessionId: "override-session", userDataRoot: join(root, "account"),
      registry: () => publishSkillRevision(1, loadSkillDefinitions({ roots: [{ authority: "external", dir: skillRoot, reach: "project" }] }).skills),
    }),
  })
  const context = { ...makeContext(), projectRoot, sessionId: "override-session", toolUseId: "override-call", sessionEventWriter: writer }
  const input = { action: "adopt-default", path: skillPath }
  try {
    const first = await tool.execute(input, context)
    expect(first.outcome).toBe("error")
    expect(first.content).toContain("carries no managed marker")
    expect(first.content).not.toContain("Ask with ask_user")

    await writer.record({
      type: "agent_input.requested", version: 3, actor: "agent",
      payload: {
        interactionId: "approval", conversationId: "conversation", toolUseId: "approval",
        request: [{ question: "Resolve?", choices: [{ kind: "option", choiceId: "approve", label: "Approve" }], multiSelect: false }],
        decision: { kind: "definition_override", preparationId: prepared.preparationId, question: "Resolve?", approve: { choiceId: "approve", label: "Approve" }, reject: { choiceId: "reject", label: "Reject" } },
      },
    })
    await writer.record({ type: "agent_input.answered", version: 3, actor: "user", payload: { interactionId: "approval", answers: { "Resolve?": { kind: "choice", selections: [{ choiceId: "approve" }], text: "Approve" } } } })
    const refused = await tool.execute({ ...input, confirmation_id: "approval" }, context)
    expect(refused.content).toContain("carries no managed marker")
    expect(existsSync(skillPath)).toBe(true)

    // The refusal left the approval unspent, so it applies once the person
    // claims the package.
    await writeFile(skillPath, "---\ndescription: Use for demonstrations.\nmanaged: user\n---\nBody.\n")
    expect((await tool.execute({ ...input, confirmation_id: "approval" }, context)).outcome).toBe("ok")
    expect(existsSync(skillPath)).toBe(false)
  } finally {
    writer.dispose()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test.each(["global", "project"] as const)("%s override publication refuses escaped store roots before planning", async (reach) => {
  const root = await mkdtemp(join(tmpdir(), "override-containment-"))
  const projectRoot = join(root, "project")
  const userDataRoot = join(root, "account")
  const outside = join(root, "outside")
  const parent = reach === "global" ? userDataRoot : join(projectRoot, ".flywheel")
  await mkdir(parent, { recursive: true })
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(parent, "skills"), "junction")
  const store = createSqliteEventStore(join(root, "store", "flywheel.sqlite"))
  const writer = createSessionFactWriter({ sessionId: "override-session", writer: asAsyncEventWriter(store) })
  const packages = createManagedPackageWrites({
    origin: { kind: "agent", sessionId: "override-session" }, store: asAsyncEventReadSurface(store), sessionId: "override-session", userDataRoot,
    registry: () => { throw new Error("An escaped store must not reach the planner") },
  })
  const input = { projectRoot, mutation: { kind: "remove_package" as const, name: "demo" }, writer, toolUseId: "override-call" }
  try {
    const result = await (reach === "global" ? packages.applyGlobal(input) : packages.applyProject(input))
    expect(result.kind).toBe("refused")
    expect(store.read({ types: ["skill.written"], afterPosition: 0 })).toHaveLength(0)
  } finally {
    writer.dispose()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
