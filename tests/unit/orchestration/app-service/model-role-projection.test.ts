import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { publishedModelRoles } from "../../../../src/orchestration/app-service/model-role-projection.js"
import { RuntimeModelRolesResultSchema } from "../../../../src/protocol/model-role-protocol-schemas.js"
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../../src/orchestration/modules.js"
import { repoModules } from "../../../helpers/project-definitions.js"

describe("published model roles", () => {
  test("publishes Workflow first in the agents group and rejects retired wire groups", () => {
    const roles = publishedModelRoles(composeFirstPartyModules())
    expect(roles.filter(({ group }) => group === "agents")[0]).toMatchObject({ id: "workflow-agent", label: "Workflow", description: "Runs the agents of workflows." })
    expect(roles.some(({ id }) => id === "step-agent")).toBe(false)
    expect(Schema.decodeUnknownSync(RuntimeModelRolesResultSchema)({ roles })).toEqual({ roles })
    const retired = { roles: [{ id: "step-agent", label: "Step Agent", group: "steps", order: 0, description: "Runs workflow steps." }] }
    expect(() => Schema.decodeUnknownSync(RuntimeModelRolesResultSchema)(retired)).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeModelRolesResultSchema)({
      roles: [{ id: "workflow-agent", label: "Workflow Agent", group: "briefs", order: 0, description: "Runs the agents of workflows." }],
    })).toThrow()
  })
  test("lists module-owned roles only while their module is installed and enabled", () => {
    const enabled = publishedModelRoles(composeFirstPartyModules(repoModules))
    expect(enabled.find(({ id }) => id === "benchmark-judge")).toMatchObject({ label: "Benchmark Judge", group: "background" })
    for (const composition of [composeFirstPartyModules(repoModules, ["development"]), composeFirstPartyModules(SHIPPED_MODULES)]) {
      const roles = publishedModelRoles(composition)
      expect(roles.some(({ id }) => id === "benchmark-judge")).toBe(false)
      expect(roles.some(({ id }) => id === "chat")).toBe(true)
      expect(roles.some(({ id }) => id === "subagent-summary")).toBe(true)
    }
  })
})
