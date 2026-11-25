import { describe, expect, test } from "bun:test"
import { declaredFactRetentionTypes, declaredRetiredFactTypes, factOwner, factRetention } from "../../../../../src/infra/substrate/store/fact-retention-registry"
import { composeFirstPartyModules } from "../../../../../src/orchestration/module-contract/module-composition.js"
import { SHIPPED_MODULES } from "../../../../../scripts/shipped-modules.js"
import type { FirstPartyModule } from "../../../../../src/orchestration/module-contract/module-catalog.js"

describe("fact retention registry ownership", () => {
  test("every classified family records one owner", () => {
    for (const type of declaredFactRetentionTypes()) {
      expect(factRetention(type)).toBeDefined()
      expect(factOwner(type)).toBeDefined()
    }
    expect(factOwner("experiment.run.recorded")).toBe("experiments")
    expect(factOwner("papercut.recorded")).toBe("papercuts")
    expect(factOwner("subagent.completed")).toBe("subagents")
    expect(factOwner("memory.written")).toBe("learning")
    expect(factOwner("attempt.started")).toBe("workflows")
    // The operational tree is a view of the latest control, so only its newest revision is live.
    expect(factOwner("queue.tree.changed")).toBe("workflows")
    expect(factRetention("queue.tree.changed")).toEqual(factRetention("queue.plan.changed"))
    expect(factOwner("session.created")).toBe("kernel")
    expect(factOwner("never.written")).toBeUndefined()
  })

  test("a module-owned family carries a prefix its module declares", () => {
    for (const type of declaredFactRetentionTypes()) {
      const owner = factOwner(type)
      if (owner === "kernel") continue
      const module: FirstPartyModule | undefined = SHIPPED_MODULES.find((candidate) => candidate.id === owner)
      expect(module?.facts?.prefixes.some((prefix) => type.startsWith(prefix))).toBe(true)
    }
  })

  test("classifies the retired session stats cache without retaining a schema", () => {
    expect(factRetention("session.stats.snapshotted")).toEqual({ policy: "retired" })
    expect(declaredRetiredFactTypes()).toContain("session.stats.snapshotted")
  })
})

describe("fact prefix claims at composition", () => {
  const module = (id: FirstPartyModule["id"], prefixes: readonly string[]): FirstPartyModule => ({
    id,
    dependencies: [],
    facts: { prefixes },
    contributions: [],
  })

  test("two modules cannot claim one prefix or a nested one", () => {
    expect(() => composeFirstPartyModules([module("experiments", ["trial."]), module("papercuts", ["trial."])])).toThrow(/Fact prefix trial\. is claimed by both/)
    expect(() => composeFirstPartyModules([module("experiments", ["trial."]), module("papercuts", ["trial.note."])])).toThrow(/Fact prefix trial\. is claimed by both experiments and papercuts/)
  })

})
