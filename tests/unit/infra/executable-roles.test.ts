import { expect, test } from "bun:test"
import { EXECUTABLE_ROLES, internalExecutableRole } from "../../../src/infra/executable-roles.js"

test("selects every internal role independently of cwd and user arguments", () => {
  for (const role of Object.values(EXECUTABLE_ROLES)) {
    expect(internalExecutableRole(["flywheel", role])).toBe(role)
    expect(internalExecutableRole(["bun", "/$bunfs/root/flywheel", role, "--", EXECUTABLE_ROLES.guardian])).toBe(role)
    expect(internalExecutableRole(["bun", "B:/~BUN/root/flywheel", role])).toBe(role)
  }
  expect(internalExecutableRole(["flywheel", "serve"])).toBeUndefined()
  expect(internalExecutableRole(["flywheel", "--internal-role=project-executor"])).toBe(EXECUTABLE_ROLES.projectExecutor)
})

test("does not dispatch roles from command payloads or after the delimiter", () => {
  for (const role of Object.values(EXECUTABLE_ROLES)) {
    expect(internalExecutableRole(["flywheel", "serve", role])).toBeUndefined()
    expect(internalExecutableRole(["flywheel", "--", role])).toBeUndefined()
    expect(internalExecutableRole(["bun", "/checkout/src/cli/index.ts", "run", role])).toBeUndefined()
    expect(internalExecutableRole(["bun", "/checkout/src/cli/index.ts", role, "--", EXECUTABLE_ROLES.guardian])).toBe(role)
  }
})
