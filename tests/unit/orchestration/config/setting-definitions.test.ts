import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { flywheelConfigKeys, FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js";
import {
  PERSISTED_SETTING_DEFINITIONS,
  RETAINED_CONFIG_SECTION_DEFINITIONS,
  settingDefinitions,
} from "../../../../src/orchestration/config/setting-definitions.js";
import { PERSISTED_SETTING_WRITERS } from "../../../../src/orchestration/config/writer.js";
import { installedConfigSections } from "../../../../src/orchestration/module-catalog.js";

describe("persisted setting definitions", () => {
  test("give each persisted root key exactly one owner", () => {
    const ownedKeys = [
      ...new Set(PERSISTED_SETTING_DEFINITIONS.map((definition) => definition.path[0])),
      ...RETAINED_CONFIG_SECTION_DEFINITIONS.map((definition) => definition.key),
      ...installedConfigSections().map((section) => section.key),
    ];

    expect(ownedKeys).toEqual([...flywheelConfigKeys()]);
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

  test("indexes every generated writer from the definitions", () => {
    expect([...PERSISTED_SETTING_WRITERS.keys()]).toEqual(
      PERSISTED_SETTING_DEFINITIONS
        .filter((definition) => definition.ownership === "generated-writer")
        .map((definition) => definition.id),
    );
  });


  test("owns the Copilot cap only in optional profile overlays", () => {
    const defaults = Schema.decodeUnknownSync(FlywheelConfigSchema)({});
    expect("providers" in defaults).toBe(false);
    expect(Schema.decodeUnknownSync(FlywheelConfigSchema)({ profiles: { work: {} } }).profiles.work?.providers).toEqual({});
    expect(Schema.decodeUnknownSync(FlywheelConfigSchema)({ profiles: { work: { providers: { github_copilot: { monthly_credit_cap: false } } } } }).profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(0);
    expect(Schema.decodeUnknownSync(FlywheelConfigSchema)({ profiles: { work: { providers: { github_copilot: { monthly_credit_cap: 1200 } } } } }).profiles.work?.providers.github_copilot?.monthly_credit_cap).toBe(1200);
  });
});
