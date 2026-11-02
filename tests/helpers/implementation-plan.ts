/** The smallest plan that the implementation plan contract
 *  (`src/workflows/workflows/contracts/implementation-plan.json`) accepts. */
export const MINIMAL_IMPLEMENTATION_PLAN = {
  summary: "Make value two.",
  schema_version: 1,
  context: { constraints: ["Make value two."] },
  milestones: [{
    id: "one",
    goal: "Set value to two.",
    files: ["value.ts"],
    tasks: [{ id: "t1", description: "Set value to 2.", files: ["value.ts"], test_scenarios: ["value is two"] }],
    verification: "bun test",
  }],
  success_criteria: ["value is two"],
}
