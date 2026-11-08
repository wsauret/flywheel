import type { RuntimeModulesView } from "../../../src/protocol/module-protocol-types.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("capability-preset-interaction-fixture.ts", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{
    name: "capability-preset-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
      builder.onLoad({ filter: /webview[\\/]src[\\/]modules\.ts$/ }, () => ({ contents: "export const WEB_MODULES = []", loader: "js" }))
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelCapabilityPresetTestClient') }", loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Preset fixture build produced no JavaScript")
const { mountCapabilityPreset }: typeof import("./capability-preset-interaction-fixture.js") = await importBuiltModule(javascript)

test("capabilities turns a provider module on with one mutation and no confirmation", async () => {
  const mounted = mountCapabilityPreset("capabilities")
  const id = "provider-claude-agent-sdk"
  const label = "Anthropic Subscription"
  try {
    mounted.publish({
      capabilities: [], moduleIds: [], descriptorIdentity: "provider-off", warnings: [],
      requireWorkflowConfirmation: true, workflowsMode: "off",
      persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
      modules: [{
        id, installed: true, effective: false, dependencies: [],
        setting: { control: "binary", group: "Model providers", label, description: "Serve Claude models through the Claude login" },
      }],
    })
    mounted.toggle(label)
    await mounted.ready()
    assert.equal(mounted.confirmations.length, 0)
    assert.deepEqual(mounted.mutations, [{ type: "settings.set_module", moduleId: id, expected: false, enabled: true }])
  } finally { mounted.dispose() }
})

for (const sheet of ["settings", "capabilities"] as const) {
  test(`${sheet} cancels Minimal, then submits the captured expectation once despite a newer snapshot`, async () => {
    const mounted = mountCapabilityPreset(sheet)
    try {
      await mounted.ready()
      assert.equal(mounted.mutations.length, 0)
      assert.ok(mounted.checkedChoices().includes("Custom"))
      mounted.choose("Minimal")
      await mounted.ready()
      assert.equal(mounted.mutations.length, 0)
      assert.equal(mounted.confirmations.length, 1)
      assert.match(mounted.confirmations[0]?.detail ?? "", /all model providers.*credentials are kept/i)
      mounted.answerDefault()
      await mounted.ready()
      assert.equal(mounted.mutations.length, 0)

      mounted.choose("Minimal")
      await mounted.ready()
      const queries = mounted.queries()
      mounted.replace()
      mounted.refuse()
      mounted.answer(true)
      await mounted.ready()
      assert.deepEqual(mounted.mutations, [{
        type: "settings.set_modules", preset: "minimal",
        expected: { moduleIds: mounted.initialModuleIds, requireWorkflowConfirmation: false, descriptorIdentity: "before" },
      }])
      // Neither sheet reads on its own: the newer selection arrives as the
      // session's module patch.
      assert.equal(mounted.queries(), queries)
      assert.deepEqual(mounted.reports, ["selection changed"])
    } finally { mounted.dispose() }
  })

  test(`${sheet} applies an explicit Full choice without confirmation`, async () => {
    const mounted = mountCapabilityPreset(sheet)
    try {
      await mounted.ready()
      const full = mounted.button("Full")
      assert.ok(full)
      full.focus()
      mounted.publishSettings({ capabilityPreset: "full" })
      assert.equal(mounted.button("Full"), full)
      assert.equal(full.properties["aria-checked"], true)
      mounted.publishSettings({ capabilityPreset: "custom" })
      assert.equal(mounted.button("Full"), full)
      mounted.choose("Full")
      await mounted.ready()
      assert.equal(mounted.confirmations.length, 0)
      assert.deepEqual(mounted.mutations, [{
        type: "settings.set_modules", preset: "full",
        expected: { moduleIds: mounted.initialModuleIds, requireWorkflowConfirmation: false, descriptorIdentity: "before" },
      }])
    } finally { mounted.dispose() }
  })

  test(`${sheet} writes the workflow mode through the settings path, marks only the chosen option, and orders a second write after it`, async () => {
    const mounted = mountCapabilityPreset(sheet)
    try {
      await mounted.ready()
      mounted.hold()
      mounted.choose("On")
      await mounted.ready()
      assert.deepEqual(mounted.mutations, [{ type: "settings.set_workflow_mode", expected: "off", mode: "on" }])
      assert.deepEqual(mounted.busyChoices(), ["On"])
      // The command panel cycles the same setting while the write runs. It
      // waits for that write rather than racing it with a stale expectation.
      mounted.cycleWorkflowMode()
      await mounted.ready()
      assert.equal(mounted.mutations.length, 1)
      mounted.release()
      await mounted.ready()
      mounted.release()
      await mounted.ready()
      assert.equal(mounted.mutations.length, 2)
      assert.deepEqual(mounted.busyChoices(), [])
    } finally { mounted.dispose() }
  })

  test(`${sheet} writes a choice back to the shown workflow mode while a write to another one runs`, async () => {
    const mounted = mountCapabilityPreset(sheet)
    try {
      await mounted.ready()
      mounted.hold()
      mounted.choose("On")
      // The row still shows Off, because the write of On has not landed. A
      // tap on Off is the person's latest choice, not a tap on the value in
      // force, so it runs after the write of On.
      mounted.choose("Off")
      await mounted.ready()
      assert.equal(mounted.mutations.length, 1)
      mounted.release()
      await mounted.ready()
      mounted.release()
      await mounted.ready()
      assert.deepEqual(mounted.mutations, [
        { type: "settings.set_workflow_mode", expected: "off", mode: "on" },
        { type: "settings.set_workflow_mode", expected: "on", mode: "off" },
      ])
    } finally { mounted.dispose() }
  })
}

test("automatic chat deletion accepts the displayed singular days and Off through the settings field", async () => {
  const mounted = mountCapabilityPreset("settings")
  try {
    await mounted.ready()
    mounted.edit("Off", "1 day", "enter")
    await mounted.ready()
    assert.deepEqual(mounted.mutations, [{
      type: "config.mutate",
      setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: 0 }, desired: 1 },
    }])
    mounted.publishSettings({ autoDeleteSessionDays: 1 })
    assert.ok(mounted.button("1 day"))
    mounted.edit("1 day", "Off", "enter")
    await mounted.ready()
    assert.deepEqual(mounted.mutations.at(-1), {
      type: "config.mutate",
      setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: 1 }, desired: 0 },
    })
  } finally { mounted.dispose() }
})

test("the settings field writes a draft typed back to the shown value while a write to another one runs, and leaving it untouched writes nothing", async () => {
  const mounted = mountCapabilityPreset("settings")
  try {
    await mounted.ready()
    mounted.hold()
    mounted.edit("50,000", "60,000", "enter")
    await mounted.ready()
    mounted.edit("50,000", undefined, "blur")
    mounted.edit("50,000", "50,000", "enter")
    await mounted.ready()
    assert.equal(mounted.mutations.length, 1)
    mounted.release()
    await mounted.ready()
    mounted.release()
    await mounted.ready()
    const thresholds = mounted.mutations.map((mutation) => mutation.type === "config.mutate" ? [mutation.setting.expected, mutation.setting.desired] : mutation.type)
    assert.deepEqual(thresholds, [[{ kind: "value", value: 50_000 }, 60_000], [{ kind: "value", value: 60_000 }, 50_000]])
  } finally { mounted.dispose() }
})

test("the settings field commits on Escape and Enter once, though the closing field also blurs", async () => {
  const mounted = mountCapabilityPreset("settings")
  try {
    await mounted.ready()
    mounted.edit("50,000", "70,000", "escape")
    await mounted.ready()
    assert.equal(mounted.mutations.length, 1)
    mounted.publishSettings({ compactionThreshold: 70_000 })
    mounted.edit("70,000", "60,000", "enter")
    await mounted.ready()
    const thresholds = mounted.mutations.map((mutation) => mutation.type === "config.mutate" ? [mutation.setting.expected, mutation.setting.desired] : mutation.type)
    assert.deepEqual(thresholds, [[{ kind: "value", value: 50_000 }, 70_000], [{ kind: "value", value: 70_000 }, 60_000]])
  } finally { mounted.dispose() }
})

test("capabilities repaints a change another client made without a read of its own, and states a selection error once", async () => {
  const mounted = mountCapabilityPreset("capabilities")
  try {
    await mounted.ready()
    const binary = { control: "binary", label: "Bash", description: "Run shell commands" } as const
    const view = (skills: boolean, error?: string): RuntimeModulesView => ({
      capabilities: skills ? ["bash", "skills"] : ["bash"], moduleIds: skills ? ["bash", "skills"] : ["bash"], descriptorIdentity: "patched",
      modules: [
        { id: "bash", installed: true, effective: true, dependencies: [], setting: { ...binary, group: "Tools" } },
        { id: "skills", installed: true, effective: skills, dependencies: [], setting: { ...binary, label: "Skills" } },
      ],
      warnings: error === undefined ? [] : [error], requireWorkflowConfirmation: false, workflowsMode: "ask",
      persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
      ...(error === undefined ? {} : { error }),
    })
    const queries = mounted.queries()
    mounted.publish(view(true))
    assert.deepEqual(mounted.switches(), [{ label: "Skills", on: true, disabled: false }, { label: "Bash", on: true, disabled: false }])
    mounted.publish(view(false))
    assert.deepEqual(mounted.switches(), [{ label: "Skills", on: false, disabled: false }, { label: "Bash", on: true, disabled: false }])
    mounted.publish(view(true, "disabled_modules names an unknown module: bogus"))
    assert.deepEqual(mounted.problems(), ["disabled_modules names an unknown module: bogus"])
    assert.ok(mounted.switches().every((entry) => entry.disabled))
    assert.equal(mounted.queries(), queries)
  } finally { mounted.dispose() }
})

test("settings states what a switch cannot show: an adjusted value and an attribution that cannot record", async () => {
  const mounted = mountCapabilityPreset("settings")
  try {
    await mounted.ready()
    assert.deepEqual(mounted.problems(), [])
    mounted.publishSettings({ problems: [{ settingId: "idleCompaction", message: "Flywheel adjusted this value to one it accepts." }] })
    assert.deepEqual(mounted.problems(), ["Flywheel adjusted this value to one it accepts."])
    mounted.publishSettings({ problems: [], gitAiAttribution: true })
    mounted.publishGitAiAttribution({ kind: "unavailable", reason: "command-not-found" })
    assert.deepEqual(mounted.problems(), ["Git AI attribution is unavailable because git-ai is not installed"])
    mounted.publishSettings({ gitAiAttribution: false })
    assert.deepEqual(mounted.problems(), [])
  } finally { mounted.dispose() }
})
