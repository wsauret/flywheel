/**
 * The two capability checks that Flywheel-owned prompt text renders from (ARCH-CONTEXT-033).
 *
 * The tree check serves text that every agent of a chat tree shares: tool text, every system prompt tier, module
 * prompt fragments, the roster, and the skill catalog. It reads only the tree's capture, so two agents of one tree
 * whose own selections differ still get the same answers, and so the same bytes (ARCH-CONTEXT-018).
 *
 * The agent check serves text that one agent alone reads, such as its opening turn, skill loads, runtime messages,
 * and tool results. It reads the tools that the agent may call and the availability of its own live selection.
 */

import type { CapabilityCheck } from "../../infra/capability-text.js";
import type { DefinitionAvailabilitySnapshot } from "../app-service/definition-availability.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import { toolRegistryFromComposition } from "./tools/tool-registry.js";

const SKILL_TERM = "skill:";
const PERSONA_TERM = "persona:";

/** One check over a set of logical tool identities and one definition availability. A skill term holds only while
 *  the skill tool is a tool term, because no agent loads a skill without it. With `skillAgentsNeedSubagent`, a skill
 *  that declares agents also needs the subagent tool. */
function capabilityCheck(toolTerms: ReadonlySet<string>, availability: DefinitionAvailabilitySnapshot, skillAgentsNeedSubagent: boolean): CapabilityCheck {
  return (term) => {
    if (term.startsWith(SKILL_TERM)) {
      const id = term.slice(SKILL_TERM.length);
      if (!toolTerms.has("skill") || availability.skills.get(id)?.modelInvocable !== true) return false;
      return !skillAgentsNeedSubagent || toolTerms.has("subagent") || (availability.skillRevision.skills.get(id)?.agents.length ?? 0) === 0;
    }
    if (term.startsWith(PERSONA_TERM)) return availability.personas.get(term.slice(PERSONA_TERM.length))?.available === true;
    return toolTerms.has(term);
  };
}

/** The tree checks already built for one tree capture, keyed by its availability and its tool terms. */
const treeChecks = new WeakMap<FirstPartyModuleComposition, WeakMap<DefinitionAvailabilitySnapshot, Map<string, CapabilityCheck>>>();

/**
 * The tree check of one capture: `toolTerms` are the logical identities of the tools that the tree's text may name,
 * and `availability` is the definition availability of the capture's enabled modules. Memoized per capture, so
 * equal inputs return the same check to every agent of the tree.
 */
export function treeCapabilityCheck(capture: FirstPartyModuleComposition, availability: DefinitionAvailabilitySnapshot, toolTerms: Iterable<string>): CapabilityCheck {
  const terms = new Set(toolTerms);
  const key = [...terms].toSorted().join("\u0000");
  let byAvailability = treeChecks.get(capture);
  if (!byAvailability) {
    byAvailability = new WeakMap();
    treeChecks.set(capture, byAvailability);
  }
  let byTools = byAvailability.get(availability);
  if (!byTools) {
    byTools = new Map();
    byAvailability.set(availability, byTools);
  }
  let check = byTools.get(key);
  if (!check) {
    check = capabilityCheck(terms, availability, false);
    byTools.set(key, check);
  }
  return check;
}

/** The logical identities of every tool that `capture` contributes and whose required capabilities the capture all
 *  enables, the tool terms of the tree check that tool factories read before planning settles the advertised set.
 *  A registration that needs a module the capture leaves off, such as `skill_manage` with Skills off, is no term. */
export function contributedToolIdentities(capture: FirstPartyModuleComposition): ReadonlySet<string> {
  const enabled = new Set<string>(capture.enabledModuleIds);
  return new Set([...toolRegistryFromComposition(capture).values()]
    .filter((registration) => registration.capabilities.every((capability) => enabled.has(capability)))
    .map((registration) => registration.tool));
}

/** The agent check of one request: `usableToolNames` are the logical identities of the tools the agent may call,
 *  and `availability` is the definition availability of its own live selection. */
export function agentCapabilityCheck(usableToolNames: ReadonlySet<string>, availability: DefinitionAvailabilitySnapshot): CapabilityCheck {
  return capabilityCheck(usableToolNames, availability, true);
}
