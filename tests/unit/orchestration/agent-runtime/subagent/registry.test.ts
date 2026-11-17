import { describe, expect, it } from "bun:test";

import { renderSubagentRoster, subagentDescription } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { makeDeps } from "./_fixtures.js";

describe("subagent tool — registry", () => {
  describe("renderSubagentRoster", () => {
    it("names each agent type with its details, while the tool description names none", () => {
      const roster = renderSubagentRoster(makeDeps().agentRegistry, () => true, false);

      expect(roster).toContain("- explorer (read-only): ");
      expect(roster).toContain("- implementer: ");
      // The roster renders in the session tier, so the tool bytes are the same for every agent.
      expect(subagentDescription(() => true, false)).not.toContain("- explorer");
    });

    it("tells an agent with no dispatchable type to do the work directly", () => {
      expect(renderSubagentRoster(new Map(), () => true, false)).toBe("# Subagents\n\nNo agent type is available for you to dispatch here, so do the work directly.");
    });

    it("adds Advisor routing policy only when Advisor is scoped", () => {
      const advisor = {
        kind: "persona" as const,
        name: "advisor",
        description: "Independent senior engineering advice.",
        role: "advisor",
        tools: ["read", "search", "list"],
        maxTurns: 20,
        systemPrompt: "Give private read-only advice.",
      };
      const withAdvisor = renderSubagentRoster(new Map([["advisor", advisor]]), () => true, false);
      const withoutAdvisor = renderSubagentRoster(makeDeps().agentRegistry, () => true, false);

      for (const text of [
        "two materially different approaches",
        "consequential decision depends on an uncertain assumption",
        "focused attempt failed",
        "expensive, risky, or difficult-to-reverse action",
        "factual lookup, keyword search, or repository discovery",
        "obvious or reversible local choice",
        "implementation",
        "review of a finished diff or plan",
        "user-selected pre-approval design review",
        "exact decision",
        "relevant context and project authority",
        "plausible alternatives",
        "evidence for and against each",
        "prior attempts and what they ruled out",
        "uncertainty",
        "fork: true only when accumulated conversation context",
        "Its guidance is private",
        "you own the decision",
        "If it fails or is unavailable",
      ]) expect(withAdvisor).toContain(text);
      expect(withoutAdvisor).not.toContain("two materially different approaches");
    });
  });

});
