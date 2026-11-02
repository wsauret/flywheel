import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { DEFAULT_USAGE_ALERT_THRESHOLDS, subscriptionUsageConfigSection } from "../../../../../src/orchestration/modules/subscription-usage/config.js"
import { configSection } from "../../../../../src/orchestration/config/config-section.js"
import { installedConfigSchema, CONFIG_DEFAULTS } from "../../../../../src/orchestration/config/schema.js"
import { createRuntimeConfigOwner } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { createRuntimeConfigProjection } from "../../../../../src/orchestration/app-service/runtime-config-projection.js"
import { loadConfig } from "../../../../../src/orchestration/config/loader.js"
import { seedConfigDefaults } from "../../../../../src/orchestration/config/writer.js"
import { installedModuleConfigSettings } from "../../../../../src/orchestration/modules.js"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function file(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "usage-config-")); roots.push(root)
  const path = join(root, "flywheel.toml")
  writeFileSync(path, source)
  return path
}

describe("Usage module configuration", () => {
  test("owns the threshold schema and defaults while the kernel schema contains no section", () => {
    expect(CONFIG_DEFAULTS).not.toHaveProperty(subscriptionUsageConfigSection.key)
    expect(configSection(CONFIG_DEFAULTS, subscriptionUsageConfigSection).alert_thresholds).toEqual(DEFAULT_USAGE_ALERT_THRESHOLDS)
    const decode = Schema.decodeUnknownSync(installedConfigSchema())
    expect(configSection(decode({ subscription_usage: { alert_thresholds: [] } }), subscriptionUsageConfigSection).alert_thresholds).toEqual([])
    for (const invalid of [[75, 75], [95, 75], [0, 100]]) expect(() => decode({ subscription_usage: { alert_thresholds: invalid } })).toThrow()
    expect(installedModuleConfigSettings().find(({ moduleId }) => moduleId === "subscription-usage")?.section).toBe(subscriptionUsageConfigSection)
  })

  test("seeds the default, migrates the exact retired seed, and preserves custom values", () => {
    for (const [source, expected] of [
      ["", [70, 90, 100]],
      ["[subscription_usage]\nalert_thresholds = [75, 90, 95, 100]\n", [70, 90, 100]],
      ["[subscription_usage]\nalert_thresholds = []\n", []],
      ["[subscription_usage]\nalert_thresholds = [80, 95]\n", [80, 95]],
    ] as const) {
      const path = file(source)
      expect(seedConfigDefaults({ configPath: path })).toEqual({ ok: true })
      expect(configSection(loadConfig(path, {}).config, subscriptionUsageConfigSection).alert_thresholds).toEqual(expected)
      const once = readFileSync(path, "utf8")
      expect(seedConfigDefaults({ configPath: path })).toEqual({ ok: true })
      expect(readFileSync(path, "utf8")).toBe(once)
    }
  })

  test("generic settings mutations preserve TOML, enforce declarations and stale values, and reset the module default", async () => {
    const path = file("# keep\n[subscription_usage]\nalert_thresholds = [80, 95] # selected\n")
    const owner = await createRuntimeConfigOwner({ configPath: path, watch: false })
    const projection = createRuntimeConfigProjection({ owner, projectRoot: "/scratch/project", publish: () => {} })
    const mutate = (key: string, expected: readonly number[], desired: readonly number[]) => projection.mutate({ type: "config.mutate", setting: { id: "module", section: subscriptionUsageConfigSection.key, key, expected: { kind: "value", value: expected }, desired } })
    try {
      expect(projection.view().values.moduleSections.subscription_usage?.alert_thresholds).toEqual([80, 95])
      expect((await mutate("alert_thresholds", [80, 95], [85, 100])).kind).toBe("committed")
      expect(readFileSync(path, "utf8")).toContain("alert_thresholds = [85, 100] # selected")
      expect((await mutate("alert_thresholds", [80, 95], [90, 100])).kind).toBe("stale")
      expect((await mutate("unknown", [], [90])).kind).toBe("parse-or-decode-failed")
      expect((await mutate("alert_thresholds", [85, 100], [95, 80])).kind).toBe("parse-or-decode-failed")
      expect((await projection.mutate({ type: "config.reset", profileId: "default" })).kind).toBe("committed")
      expect(projection.view().values.moduleSections.subscription_usage?.alert_thresholds).toEqual(DEFAULT_USAGE_ALERT_THRESHOLDS)
    } finally { projection.dispose(); await owner.dispose() }
  })

  test("disabled Usage retains the section and refuses its hidden setting writes", async () => {
    const source = 'disabled_modules = ["subscription-usage"]\n[subscription_usage]\nalert_thresholds = [80, 95]\n'
    const path = file(source)
    const owner = await createRuntimeConfigOwner({ configPath: path, watch: false })
    const projection = createRuntimeConfigProjection({ owner, projectRoot: "/scratch/project", publish: () => {} })
    try {
      expect(configSection(owner.snapshot().config, subscriptionUsageConfigSection).alert_thresholds).toEqual([80, 95])
      const result = await projection.mutate({ type: "config.mutate", setting: { id: "module", section: subscriptionUsageConfigSection.key, key: "alert_thresholds", expected: { kind: "value", value: [80, 95] }, desired: [] } })
      expect(result.kind).toBe("parse-or-decode-failed")
      expect(readFileSync(path, "utf8")).toBe(source)
    } finally { projection.dispose(); await owner.dispose() }
  })
})
