import { createChatLearningReview, learningChatHost } from "./learning/chat-review.js";
import { ImprovementFactSchemas } from "../../workflows/improvements/improvement-facts.js";
import { MemoryFactSchemas } from "../../workflows/memory/memory-facts.js";
import { SkillFactSchemas } from "../../workflows/skill-facts.js";
import { createMemoryStoreConfig, renderMemorySnapshot } from "./learning/memory-store.js";
import { createManagedPackageWrites } from "./learning/managed-package-writes.js";
import { memoryConfigSection, skillsConfigSection } from "./learning/config.js";
import { migrateMemoryWrittenFacts } from "./learning/migrations/memory-written.js";
import { migrateSkillFactReach } from "./learning/migrations/skill-scope.js";
import type { LearningScope } from "../../infra/learning-scope.js";
import { Log } from "../../infra/log.js";
import { moduleRuntimeHandle } from "../../infra/module-runtime.js";
import type { MutationEvidence } from "../../infra/mutation-evidence.js";
import type { ModuleRuntimeServices } from "../agent-runtime/module-runtime-services.js";
import { createMemoryTool, type MemoryToolDeps } from "./learning/tools/memory.js";
import { createSkillManageTool, type SkillManageToolDeps } from "./learning/tools/skill-manage.js";
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js";
import type { FirstPartyModule } from "../modules.js";
import type { CliCommandContext, CliNounContribution, CliVerb } from "../cli-contribution.js";

/** The durable-learning write surfaces of one runner. Both are always built
 *  for an enabled module so the tool schema surface stays identical across
 *  chat, workers, subagents, and the review fork. */
export interface LearningRuntime {
  readonly memory: MemoryToolDeps
  readonly skillManage: SkillManageToolDeps
}

const learningRuntime = moduleRuntimeHandle<LearningRuntime>("learning")

function createLearningRuntime(services: ModuleRuntimeServices): LearningRuntime {
  const { sessionId, sessionEventStore, review } = services
  return {
    memory: {
      accountHome: services.accountHome,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionEventStore ? { store: sessionEventStore } : {}),
      ...(review ? {
        origin: { kind: "review" as const, reviewRunId: review.reviewRunId },
        ...(review.onWritten ? { onWritten: (action: { target: LearningScope; action: string; mutationEvidence?: MutationEvidence }) => review.onWritten?.({ surface: "memory", name: action.target, action: action.action, reach: action.target, ...(action.mutationEvidence ? { mutationEvidence: action.mutationEvidence } : {}) }) } : {}),
      } : {}),
    },
    skillManage: {
      userDataRoot: services.userDataRoot,
      origin: review
        ? { kind: "review", reviewRunId: review.reviewRunId, loadedSkillIds: services.loadedSkillIds }
        : { kind: "agent", sessionId: sessionId ?? services.conversation.providerSessionKey },
      registry: services.definitions.skills,
      ...(services.definitions.publishNow ? { publishDefinitions: services.definitions.publishNow } : {}),
      ...(sessionEventStore ? { store: sessionEventStore } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(review?.onCandidate ? { onCandidate: review.onCandidate } : {}),
      ...(review?.onWritten ? { onWritten: (action: { name: string; action: string; reach: LearningScope; mutationEvidence?: MutationEvidence }) => review.onWritten?.({ surface: "skill", name: action.name, action: action.action, reach: action.reach, ...(action.mutationEvidence ? { mutationEvidence: action.mutationEvidence } : {}) }) } : {}),
      ...(review?.onRecommended ? { onRecommended: review.onRecommended } : {}),
    },
  }
}

const memory = {
  category: "opt-in",
  action: "ui_meta",
  cloneInheritance: "inherit",
  learningReviewExecutable: true,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 9,
  registrations: {
    memory: {
      capabilities: ["learning"],
      create: ({ kernel, modules }) => {
        const runtime = modules.get(learningRuntime)
        return runtime ? { tool: createMemoryTool(runtime.memory, kernel.treeCapabilities) } : { reason: "no memory store available" }
      },
    },
  },
} as const satisfies ToolDeclaration<"learning">;

const skillManage = {
  category: "opt-in",
  action: "ui_meta",
  cloneInheritance: "inherit",
  learningReviewExecutable: true,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 13,
  registrations: {
    skill_manage: {
      capabilities: ["learning", "skills"],
      create: ({ modules }) => {
        const runtime = modules.get(learningRuntime)
        if (!runtime) return { reason: "no skill store available" }
        return { tool: createSkillManageTool(runtime.skillManage) }
      },
    },
  },
} as const satisfies ToolDeclaration<"learning" | "skills">;

/** The durable memory block one request carries. Writable only while the
 *  request advertises the memory tool. */
function renderMemoryPromptFragment(snapshot: string, writable: boolean): string {
  const access = writable
    ? "A snapshot taken when this work started (in a chat, at the person's latest message); memory tool writes are durable at once and appear here in a later snapshot."
    : "A snapshot taken when this work started (in a chat, at the person's latest message). This snapshot is read-only."
  // A writable snapshot comes with the memory tool, whose description owns what to save and where else it goes.
  const policy = writable
    ? ""
    : " Memory is a scarce, selective profile of the user and their working context across many sessions, not session notes. Keep progress, plans, handoffs, and temporary findings in session notes. Shared repository guidance belongs in AGENTS.md or its existing authority, not memory."
  return `# Durable Memory\n\n${access}${policy} Project reach applies to this project only; global reach follows the user into every project. Each block states its reach and the sha256 of the content loaded here. Entries labeled [protected] are user-owned and permanent until the user edits the memory file. Never use memory or any other tool to change their content or protection marker.\n\n${snapshot}`
}

const skillsCli = () => import("./learning/cli/skills.js")
type SkillsCli = Awaited<ReturnType<typeof skillsCli>>

/** Skill verbs write diagnostics while they read and repair the library, so
 *  the project's debug log opens before any of them runs; `memory show` is a
 *  pure read and opens none. Each verb loads its owner on first use, so the
 *  catalog never pulls the command line onto a runtime's startup path. */
function skillsVerb(syntax: string, description: string, run: (skills: SkillsCli, args: readonly string[], context: CliCommandContext) => Promise<void>): CliVerb {
  return {
    syntax,
    description,
    run: async (args, context) => {
      await Log.init({ dir: context.directories.projectRoot })
      await run(await skillsCli(), args, context)
    },
  }
}

const skillsNoun = {
  usage: "Usage: flywheel skills <list|why|restore|prune|cleanup|maintain|doctor> [args]",
  verbs: {
    list: skillsVerb("list", "List installed skills with load counts from durable facts.", (skills, args, { directories }) => skills.runSkillsList(args, directories)),
    why: skillsVerb("why <name>", "Trace a skill's loads and writes to sessions and requests.", (skills, args, { directories }) => skills.runSkillsWhy(args, directories)),
    restore: skillsVerb("restore <name>", "Restore an archived learned skill.", (skills, args, { directories }) => skills.runSkillsRestore(args, directories)),
    prune: skillsVerb("prune [--dry-run]", "Archive learned skills with no activity in the window.", (skills, args, { directories }) => skills.runSkillsPrune(args, directories)),
    cleanup: skillsVerb("cleanup --force", "Run forced learned-skill corpus cleanup.", (skills, args, { directories, launcher }) => skills.runSkillsCleanup(args, directories, launcher.scope)),
    maintain: skillsVerb("maintain", "Survey or apply learned-skill maintenance.", (skills, args, { directories, launcher }) => skills.runSkillsMaintain(args, directories, launcher.scope)),
    doctor: skillsVerb("doctor", "Inspect learned skills and repair moved paths.", (skills, args, { directories }) => skills.runSkillsDoctor(args, directories)),
  },
} as const satisfies CliNounContribution

const memoryNoun = {
  usage: "Usage: flywheel memory show [args]",
  verbs: {
    show: {
      syntax: "show",
      description: "Print both memory stores with usage against their limits.",
      run: async (args, { directories }) => {
        const { runMemoryShow } = await import("./learning/cli/memory.js")
        runMemoryShow(args, directories)
      },
    },
  },
} as const satisfies CliNounContribution

export const learningModule = {
  id: "learning",
  dependencies: [],
  availability: { kind: "available" },
  runtime: { handle: learningRuntime, create: createLearningRuntime },
  // Memory, skill, and improvement families, defined in `src/workflows/`.
  facts: { prefixes: ["memory.", "skill.", "improvement."], sessionSchemas: () => [...ImprovementFactSchemas, ...MemoryFactSchemas, ...SkillFactSchemas] as const },
  definitionReconciliation: { prepare: async (input) => (await import("./learning/definition-reconciliation.js")).prepareLearningDefinitionReconciliation(input) },
  maintenance: [
    { phase: "before-store", run: async (input) => { await (await import("./learning/maintenance.js")).maintainSkillLifecycleIfAdmitted(input) } },
    { phase: "after-store", run: async (input) => { await (await import("./learning/maintenance.js")).maintainSkillCorpus(input) } },
  ],
  retiredConfig: [{ section: "self_improvement", key: "enabled", label: "Learning" }],
  workspaceMigrations: [
    { phase: "stored-facts", order: 100, label: "memory facts", run: ({ dbFile }) => { migrateMemoryWrittenFacts(dbFile) } },
    { phase: "stored-facts", order: 110, label: "skill reach", run: ({ dbFile }) => { migrateSkillFactReach(dbFile) } },
  ],
  contributions: [
    { domain: "chatHosts", id: "learning", value: { handle: learningChatHost, create: createChatLearningReview } },
    { domain: "config", id: "memory", value: memoryConfigSection },
    { domain: "config", id: "skills", value: skillsConfigSection },
    { domain: "managedPackageWrites", id: "learning", value: { create: (modules) => {
      const runtime = modules.get(learningRuntime)
      return runtime ? createManagedPackageWrites(runtime.skillManage) : undefined
    } } },
    { domain: "tools", id: "memory", value: { kind: "tool", name: "memory", declaration: memory } },
    { domain: "tools", id: "skill_manage", value: { kind: "tool", name: "skill_manage", declaration: skillManage } },
    { domain: "cli", id: "skills", value: skillsNoun },
    { domain: "cli", id: "memory", value: memoryNoun },
    { domain: "promptFragments", id: "learning-memory", value: {
      order: 0,
      render: ({ tools, memorySnapshot }) => memorySnapshot === null ? undefined : renderMemoryPromptFragment(memorySnapshot, tools.has("memory")),
    } },
    { domain: "memory", id: "learning-memory", value: { snapshot: ({ projectRoot, accountHome }) => renderMemorySnapshot(createMemoryStoreConfig(projectRoot, accountHome)) } },
    { domain: "settings", id: "learning", value: { control: "binary", label: "Learning", description: "Enable durable memory and learning tools" } },
    { domain: "commands", id: "learn", value: {
      id: "learn",
      title: "Learn",
      description: "Run the learning review on this session now",
      // Retired spelling; retires at the launch cut.
      aliases: ["reflect"],
      execute: async (host) => {
        const reviewed = await host.session?.review()
        return reviewed ? { kind: "none" } : { kind: "warning", message: "No active chat session to review" }
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule;
