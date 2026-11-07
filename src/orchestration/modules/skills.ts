import { getPersonaMetadataIndex } from "../../workflows/agents/agent-roles.js"
import { createSkillTool, SKILL_TOOL_DEFINITION } from "../agent-runtime/tools/skill.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../modules.js"

const skill = {
  category: "ambient",
  action: "ui_meta",
  cloneInheritance: "inherit",
  learningReviewExecutable: true,
  semanticBundle: null,
  personaBaseline: true,
  personaOrder: 8,
  registryOrder: 12,
  registrations: {
    skill: {
      capabilities: ["skills"],
      create: ({ kernel, modules }) => {
        const revision = kernel.skills
        if (!revision) return { unusable: { tool: SKILL_TOOL_DEFINITION, reason: "no skill registry available" } }
        if (revision.modelInvocable.length === 0) return { unusable: { tool: SKILL_TOOL_DEFINITION, reason: "no model-invocable skills installed" } }
        // A workflow attempt's captured external grant is the narrower
        // authority, so it wins over the session's experiment finalizer.
        const childGrant = kernel.externalSkillChildGrant ?? kernel.moduleSnapshot.contributions
          .filter((contribution) => contribution.domain === "skillChildGrants")
          .toSorted((left, right) => left.value.order - right.value.order)
          .map((contribution) => contribution.value.create({ modules, revision }))
          .find((grant) => grant !== undefined)
        return { tool: createSkillTool({
          revision,
          treeCapabilities: kernel.treeCapabilities,
          availability: kernel.definitionAvailability.live,
          personaIndex: getPersonaMetadataIndex(),
          ...(kernel.onSkillLoad ? { onLoad: kernel.onSkillLoad } : {}),
          ...(childGrant ? { childGrant } : {}),
        }) }
      },
    },
  },
} as const satisfies ToolDeclaration<"skills">


export const skillsModule = {
  id: "skills",
  dependencies: [],
  availability: { kind: "available" },
  // An unattended chat leaves out the skill tool and its catalog (PI-AGENT-121).
  attended: true,
  contributions: [
    { domain: "tools", id: "skill", value: { kind: "tool", name: "skill", declaration: skill, associatedPromptRosterIds: ["skills"] } },
    { domain: "promptRosters", id: "skills", value: { definition: "skills", visibility: "model-invocable" } },
    { domain: "definitions", id: "skills", value: { kind: "skills", retainInstalled: true } },
    { domain: "settings", id: "skills", value: { control: "binary", label: "Skills", description: "Load and manage reusable skill packages" } },
    { domain: "health", id: "skills", value: {
      title: "Skill library",
      check: async (host) => {
        // Loaded on use: the check builds a definition registry, which is
        // startup weight the catalog's import closure must not carry.
        const { summariseSkillHealth } = await import("../definition-health.js")
        return summariseSkillHealth(host.directories)
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
