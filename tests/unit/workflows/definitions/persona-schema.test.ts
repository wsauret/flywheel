import { safeParse } from "../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import { createPersonaDefinitionSchema } from "../../../../src/workflows/agents/persona-schema.js";

const PersonaDefinitionSchema = createPersonaDefinitionSchema(["read", "write"]);
describe("PersonaDefinitionSchema", () => {
  it("requires role and rejects empty tool lists", () => {
    expect(safeParse(PersonaDefinitionSchema, {
      name: "implementer",
      description: "does work",
    }).success).toBe(false);

    expect(safeParse(PersonaDefinitionSchema, {
      name: "implementer",
      description: "does work",
      role: "implementer",
      tools: [],
    }).success).toBe(false);
  });
});
