import { describe, expect, test } from "bun:test";
import {
  settingDefinitions,
  type ApplicationMode,
} from "../../../../src/orchestration/config/setting-definitions.js";

const CANONICAL_MODES = new Set<ApplicationMode>([
  "live",
  "next-request",
  "replace-resource",
  "use-time-revalidate",
  "next-use",
]);

describe("config application modes", () => {
  test("defines a total, structurally valid application contract", () => {
    const ids = settingDefinitions().map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);

    const observedModes = new Set<ApplicationMode>();
    for (const definition of settingDefinitions()) {
      expect(definition.applications.length).toBeGreaterThan(0);
      const identities = definition.applications.map(({ mode, path }) => {
        expect(CANONICAL_MODES.has(mode)).toBe(true);
        expect(path.every((segment) => segment.length > 0)).toBe(true);
        observedModes.add(mode);
        return `${mode}:${path.join(".")}`;
      });
      expect(new Set(identities).size).toBe(identities.length);
    }
    expect(observedModes).toEqual(CANONICAL_MODES);
  });

  test("derives a protocol-safe catalog without secret-bearing sections", () => {
    const omitted = settingDefinitions()
      .filter(({ protocolExposure }) => protocolExposure === "secret")
      .map(({ id }) => id);

    expect(omitted).toEqual(["auth", "custom_providers", "mcp"]);
    expect(settingDefinitions().filter(({ protocolExposure }) => protocolExposure === "ui-safe")).toHaveLength(28);
    expect(settingDefinitions().find(({ id }) => id === "writeSyntaxTheme")).toMatchObject({
      applications: [{ mode: "live", path: [] }],
      protocolExposure: "ui-safe",
    });
  });
});
