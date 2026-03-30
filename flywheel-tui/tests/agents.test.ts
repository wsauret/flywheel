import { describe, test, expect, beforeEach } from "bun:test";
import {
  loadAgents,
  getAgent,
  getAgentsByCategory,
  getAgentNames,
  getAllAgents,
  clearAgentCache,
} from "../src/agents/registry";

beforeEach(() => {
  clearAgentCache();
});

describe("Agent Registry", () => {
  test("loads all 15 agent personas", async () => {
    const agents = await loadAgents();
    expect(agents.size).toBe(15);
  });

  test("caches results on subsequent calls", async () => {
    const first = await loadAgents();
    const second = await loadAgents();
    expect(first).toBe(second); // same reference
  });

  test("names follow fly/<category>-<domain> pattern", async () => {
    const agents = await getAllAgents();
    for (const agent of agents) {
      expect(agent.name).toMatch(/^fly\/(reviewer|locator|analyzer)-/);
    }
  });

  describe("getAgent", () => {
    test("returns a reviewer by fully qualified name", async () => {
      const agent = await getAgent("fly/reviewer-architecture");
      expect(agent).toBeDefined();
      expect(agent!.name).toBe("fly/reviewer-architecture");
      expect(agent!.shortName).toBe("reviewer-architecture");
      expect(agent!.category).toBe("reviewer");
      expect(agent!.model).toBe("sonnet");
      expect(agent!.body.length).toBeGreaterThan(100);
    });

    test("returns a locator by fully qualified name", async () => {
      const agent = await getAgent("fly/locator-codebase");
      expect(agent).toBeDefined();
      expect(agent!.category).toBe("locator");
      expect(agent!.model).toBe("haiku");
    });

    test("returns an analyzer by fully qualified name", async () => {
      const agent = await getAgent("fly/analyzer-codebase");
      expect(agent).toBeDefined();
      expect(agent!.category).toBe("analyzer");
      expect(agent!.model).toBe("sonnet");
    });

    test("returns undefined for unknown agent", async () => {
      const agent = await getAgent("fly/reviewer-nonexistent");
      expect(agent).toBeUndefined();
    });
  });

  describe("getAgentsByCategory", () => {
    test("returns 6 reviewers", async () => {
      const reviewers = await getAgentsByCategory("reviewer");
      expect(reviewers.length).toBe(6);
      const names = reviewers.map((a) => a.shortName).sort();
      expect(names).toEqual([
        "reviewer-architecture",
        "reviewer-code-quality",
        "reviewer-data-integrity",
        "reviewer-patterns",
        "reviewer-performance",
        "reviewer-plan-philosophy",
      ]);
    });

    test("returns 4 locators", async () => {
      const locators = await getAgentsByCategory("locator");
      expect(locators.length).toBe(4);
      const names = locators.map((a) => a.shortName).sort();
      expect(names).toEqual([
        "locator-codebase",
        "locator-docs",
        "locator-patterns",
        "locator-web",
      ]);
    });

    test("returns 5 analyzers", async () => {
      const analyzers = await getAgentsByCategory("analyzer");
      expect(analyzers.length).toBe(5);
      const names = analyzers.map((a) => a.shortName).sort();
      expect(names).toEqual([
        "analyzer-codebase",
        "analyzer-docs",
        "analyzer-git-history",
        "analyzer-patterns",
        "analyzer-web",
      ]);
    });
  });

  describe("getAgentNames", () => {
    test("returns fully qualified names for reviewers", async () => {
      const names = await getAgentNames("reviewer");
      expect(names.length).toBe(6);
      for (const name of names) {
        expect(name).toMatch(/^fly\/reviewer-/);
      }
    });
  });

  describe("persona content", () => {
    test("all agents have non-empty body", async () => {
      const agents = await getAllAgents();
      for (const agent of agents) {
        expect(agent.body.length).toBeGreaterThan(50);
      }
    });

    test("all agents have tools array", async () => {
      const agents = await getAllAgents();
      for (const agent of agents) {
        expect(Array.isArray(agent.tools)).toBe(true);
        expect(agent.tools.length).toBeGreaterThan(0);
      }
    });

    test("all agents have skills array", async () => {
      const agents = await getAllAgents();
      for (const agent of agents) {
        expect(Array.isArray(agent.skills)).toBe(true);
        expect(agent.skills.length).toBeGreaterThan(0);
      }
    });

    test("locators use haiku model", async () => {
      const locators = await getAgentsByCategory("locator");
      for (const agent of locators) {
        expect(agent.model).toBe("haiku");
      }
    });

    test("reviewers use sonnet model", async () => {
      const reviewers = await getAgentsByCategory("reviewer");
      for (const agent of reviewers) {
        expect(agent.model).toBe("sonnet");
      }
    });

    test("analyzers use sonnet model", async () => {
      const analyzers = await getAgentsByCategory("analyzer");
      for (const agent of analyzers) {
        expect(agent.model).toBe("sonnet");
      }
    });
  });
});
