import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  registerHandoffType,
  getHandoffType,
  getAllHandoffTypes,
  type HandoffType,
} from "../../src/workflows/handoff-types/registry.js";
import type { HandoffFieldSpec } from "../../src/workflows/queue/shared/handoff-render.js";

function synthetic(): HandoffType {
  const name = `test-type-${randomUUID()}`;
  const fields: HandoffFieldSpec[] = [
    { key: "summary", description: "s", example: '"x"', required: true },
  ];
  const schema = z.object({ summary: z.string() });
  return { name, fields, schema, description: "synthetic" };
}

describe("handoff-type registry", () => {
  it("registerHandoffType + getHandoffType returns same object reference", () => {
    const type = synthetic();
    registerHandoffType(type);
    expect(getHandoffType(type.name)).toBe(type);
  });

  it("getHandoffType returns undefined for an unregistered name", () => {
    const missing = `test-type-${randomUUID()}`;
    expect(getHandoffType(missing)).toBeUndefined();
  });

  it("duplicate registration throws with the name in the message", () => {
    const type = synthetic();
    registerHandoffType(type);
    expect(() => registerHandoffType(type)).toThrow(
      `Duplicate handoff type registration: ${type.name}`,
    );
  });

  it("getAllHandoffTypes returns each registered synthetic type exactly once", () => {
    const a = synthetic();
    const b = synthetic();
    registerHandoffType(a);
    registerHandoffType(b);
    const names = getAllHandoffTypes().map((t) => t.name);
    expect(names.filter((n) => n === a.name)).toHaveLength(1);
    expect(names.filter((n) => n === b.name)).toHaveLength(1);
  });
});
