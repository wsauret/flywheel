import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { installedConfigSchema } from "../../../../../src/orchestration/config/schema/schema.js";
import {
  PERSISTED_SETTING_DEFINITIONS,
  settingDefinitions,
} from "../../../../../src/orchestration/config/schema/setting-definitions.js";

describe("persisted setting definitions", () => {
  test("give each persisted root key exactly one owner", () => {
    const ownedKeys = [
      ...new Set(PERSISTED_SETTING_DEFINITIONS.map((definition) => definition.path[0])),
      ...settingDefinitions().flatMap((definition) => definition.kind === "retained-section" ? [definition.key] : []),
    ];

    expect(new Set(ownedKeys).size).toBe(ownedKeys.length);
  });

  test("contain only valid discriminated presentation and ownership variants", () => {
    for (const definition of settingDefinitions()) {
      if (definition.kind === "retained-section") {
        expect(definition.presentation.kind).toBe("none");
        continue;
      }

      if (definition.ownership === "runtime-owned") {
        expect(definition.presentation.kind).toBe("none");
        expect("reset" in definition ? definition.reset : undefined).toBeUndefined();
      }

      if (definition.presentation.kind === "simple-enum") {
        expect(definition.presentation.values.length).toBeGreaterThan(1);
      }
    }
  });


  test("owns the Copilot cap only in optional profile overlays", () => {
    const defaults = Schema.decodeUnknownSync(installedConfigSchema())({});
    expect("providers" in defaults).toBe(false);
    expect(Schema.decodeUnknownSync(installedConfigSchema())({ profiles: { work: {} } }).profiles.work?.providers).toEqual({});
    expect(Schema.decodeUnknownSync(installedConfigSchema())({ profiles: { work: { providers: { github_copilot: { monthly_credit_cap: false } } } } }).profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(0);
    expect(Schema.decodeUnknownSync(installedConfigSchema())({ profiles: { work: { providers: { github_copilot: { monthly_credit_cap: 1200 } } } } }).profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(1200);
  });
});
