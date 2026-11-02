import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { createStepGate, serveStepGate, type StepAsk } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { forwardDiagnostics, payloads } from "./_bridge-harness.js";

const STEP_GATE_MODULE = join(import.meta.dir, "../../../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate.ts");
/** The plugin's source folder. Each copy holds the same JSON values and the hook module byte for byte. */
const PLUGIN_SOURCE = join(import.meta.dir, "../../../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate-plugin");
/** Each JSON file of a copy, and its source. The manifest's source has no dot folder, which a source snapshot skips. */
const PLUGIN_JSON_FILES: ReadonlyArray<readonly [string, string]> = [[".claude-plugin/plugin.json", "plugin.json"], ["hooks/hooks.json", "hooks/hooks.json"]];
/** The hook module as each copy names it, and its source, which ends in `.txt` for Bun's text loader. */
const PLUGIN_HOOK_MODULE = "hooks/register.js";
const PLUGIN_HOOK_SOURCE = "hooks/register.js.txt";
const temporary = temporaryDirectories();
forwardDiagnostics();

const step = (turnId: string, index: number): StepAsk => ({ turnId, index, messageCount: 3 });

const readText = (root: string, file: string): string => readFileSync(join(root, file), "utf8");

function gateWithRefusals() {
  const refused: StepAsk[] = [];
  return { gate: createStepGate((ask) => { refused.push(ask); }), refused };
}

/** Every file under `root`, as paths relative to it. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
}

describe("the step gate", () => {
  test("a pushed message's admission admits only the first step of a new turn, so a late step of the previous turn cannot use it", () => {
    const { gate, refused } = gateWithRefusals();
    gate.arm("turn-start");
    expect(gate.ask(step("turn-1", 0))).toBe(true);
    gate.arm("turn-start");
    // The CLI continues the earlier turn by itself, such as a nudge after the reply, while Flywheel's push waits.
    expect(gate.ask(step("turn-1", 1))).toBe(false);
    expect(gate.armed()).toBe(true);
    expect(gate.ask(step("turn-2", 0))).toBe(true);
    expect(gate.armed()).toBe(false);
    expect(refused).toEqual([step("turn-1", 1)]);
  });

  test("a delivery's admission admits only the next step of the admitted step's turn", () => {
    const { gate, refused } = gateWithRefusals();
    gate.arm("turn-start");
    expect(gate.ask(step("turn-1", 0))).toBe(true);
    gate.arm("continuation");
    expect(gate.ask(step("turn-2", 0))).toBe(false);
    expect(gate.ask(step("turn-1", 2))).toBe(false);
    expect(gate.ask(step("turn-1", 1))).toBe(true);
    expect(gate.ask(step("turn-1", 2))).toBe(false);
    expect(refused).toEqual([step("turn-2", 0), step("turn-1", 2), step("turn-1", 2)]);
  });

  test("a replayed turn start's admission refuses that turn's first step without a report, and admits nothing", () => {
    const { gate, refused } = gateWithRefusals();
    gate.arm("turn-start");
    expect(gate.ask(step("turn-1", 0))).toBe(true);
    gate.arm("replayed-turn-start");
    // A late step of the earlier turn is the CLI's own and is reported as before.
    expect(gate.ask(step("turn-1", 1))).toBe(false);
    expect(gate.ask(step("turn-2", 0))).toBe(false);
    expect(gate.armed()).toBe(false);
    expect(gate.ask(step("turn-2", 1))).toBe(false);
    expect(refused).toEqual([step("turn-1", 1), step("turn-2", 1)]);
    // The next pushed message starts a turn of its own, which its admission admits.
    gate.arm("turn-start");
    expect(gate.ask(step("turn-3", 0))).toBe(true);
  });

  test("a continuation with no admitted step before it, and every step after the close, is refused", () => {
    const { gate } = gateWithRefusals();
    gate.arm("continuation");
    expect(gate.ask(step("turn-1", 1))).toBe(false);
    gate.close();
    gate.arm("turn-start");
    expect(gate.armed()).toBe(false);
    expect(gate.ask(step("turn-1", 0))).toBe(false);
  });

  test("each query loads a private copy of the plugin, also from a bundle away from the module's folder as in a compiled build, and the close removes it with the socket", async () => {
    // A compiled build runs the bundle from `/$bunfs`, where no plugin folder exists beside it.
    const outdir = temporary("step-gate-bundle-");
    const build = await Bun.build({ entrypoints: [STEP_GATE_MODULE], outdir, target: "bun" });
    expect(build.success).toBe(true);
    const bundled: typeof import("../../../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate.js") = await import(join(outdir, "step-gate.js"));
    const { gate } = gateWithRefusals();
    const server = bundled.serveStepGate(gate);
    try {
      expect(filesUnder(server.pluginPath)).toEqual([...PLUGIN_JSON_FILES.map(([copy]) => copy), PLUGIN_HOOK_MODULE]);
      for (const [copy, source] of PLUGIN_JSON_FILES) {
        expect(JSON.parse(readText(server.pluginPath, copy))).toEqual(JSON.parse(readText(PLUGIN_SOURCE, source)));
      }
      expect(readText(server.pluginPath, PLUGIN_HOOK_MODULE)).toBe(readText(PLUGIN_SOURCE, PLUGIN_HOOK_SOURCE));
      // Windows has no mode bits: the directory sits in the account's own temporary folder, which only the account can open.
      if (process.platform !== "win32") expect(statSync(join(server.pluginPath, "..")).mode & 0o777).toBe(0o700);
    } finally {
      server.close();
    }
    expect(existsSync(server.pluginPath)).toBe(false);
    expect(existsSync(server.socketPath)).toBe(false);
  });

  test("a body that the gate cannot read gets no admission and is recorded by its size, and the gate counts it beside the asks it answered", async () => {
    const { gate } = gateWithRefusals();
    gate.arm("turn-start");
    const server = serveStepGate(gate);
    const post = (body: string) => fetch("http://localhost/step", { unix: server.socketPath, method: "POST", body });
    // The record is a per-request family, which the debug level writes.
    DebugLog.setVerbose(true);
    try {
      const admitted = await post(JSON.stringify(step("turn-1", 0)));
      expect(await admitted.json()).toEqual({ admit: true });
      const unread = await post("{not json");
      expect({ status: unread.status, body: await unread.json() }).toEqual({ status: 400, body: { admit: false } });
      expect(payloads("provider.claude_sdk.step_gate.rejected")).toEqual([{ bytes: 9 }]);
      expect(server.evidence()).toEqual({ asks: 1, rejected: 1, socketPathBytes: Buffer.byteLength(server.socketPath) });
    } finally {
      DebugLog.setVerbose(false);
      server.close();
    }
  });
});
