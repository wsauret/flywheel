import { beforeAll, describe, expect, it } from "bun:test";
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import type { KernelToolDeps } from "../../../../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { withCapabilityGrant, type CapabilityAccess } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { makeContext } from "./_fixtures.js";
import { defaultModuleState } from "../../../../../src/orchestration/config/module-descriptor.js";

const { userDataRoot } = testDirectories(process.cwd());
const plan = (kernel: Partial<KernelToolDeps>) => planToolExposure({ kernel: testKernelToolDeps({ userDataRoot, ...kernel }), modules: NO_MODULE_RUNTIMES });

beforeAll(loadBashParser);

describe("background management under capability policy", () => {
  const capabilities = (held: readonly string[]) => ({ available: (capability: string) => held.includes(capability) });
  const registry = () => createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });

  it("keeps background management while any producer of background work is enabled", async () => {
    for (const held of [["workflows"], ["subagents"], ["background-commands"]]) {
      const planned = await plan({ backgroundTasks: registry(), capabilities: capabilities(held) });

      expect(planned.tools.has("process")).toBe(true);
    }
  });

  it("advertises one bash definition whatever Background Commands and persistence allow", async () => {
    const definitions = await Promise.all([[], ["background-commands"]].flatMap((held) => [false, true].map(async (persistentProcesses) => {
      const planned = await plan({ capabilities: capabilities(held), backgroundTasks: registry(), persistentProcesses });
      const { description, promptGuidelines, inputSchema } = planned.tools.get("bash")!;
      return JSON.stringify({ description, promptGuidelines, inputSchema });
    })));

    expect(new Set(definitions).size).toBe(1);
    expect(definitions[0]).toContain('"background"');
    expect(definitions[0]).toContain('"persist_after_exit"');
    expect(definitions[0]).toContain("Timeouts are entirely optional and should be used sparingly. They apply equally to foreground and managed background commands.");
  });

  it("refuses each advertised input this agent cannot use, before any effect", async () => {
    const backgroundTasks = registry();
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    const effects: string[] = [];
    const context = makeContext({
      spawnOwned: () => { effects.push("spawn"); throw new Error("a refused input must not launch"); },
      admitPersistentProcess: () => { effects.push("admit"); return true; },
      backgroundTasks,
      foregroundBashHold,
    });
    const foregroundOnly = await plan({ capabilities: capabilities([]), backgroundTasks, foregroundBashHold, persistentProcesses: true });
    const withoutPersistence = await plan({ capabilities: capabilities(["background-commands"]), backgroundTasks, foregroundBashHold, persistentProcesses: false });

    for (const [tools, input, field] of [
      [foregroundOnly.tools, { command: "bun server.ts", background: true }, "background"],
      [foregroundOnly.tools, { command: "bun server.ts", background: true, persist_after_exit: true }, "persist_after_exit"],
      [withoutPersistence.tools, { command: "bun server.ts", background: true, persist_after_exit: true }, "persist_after_exit"],
    ] as const) {
      expect(await tools.get("bash")!.execute(input, context)).toEqual({
        content: `The ${field} input of bash is unavailable to this agent now. Do not send it again.`,
        outcome: "error",
      });
    }
    expect(effects).toEqual([]);
    foregroundBashHold.dispose();
  });

  it("rechecks live persistence admission when executing a planned request", async () => {
    const backgroundTasks = registry();
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    const planned = await plan({ capabilities: capabilities(["background-commands"]), backgroundTasks, foregroundBashHold, persistentProcesses: true });
    let admissionChecks = 0;

    let launches = 0;
    const result = await planned.tools.get("bash")!.execute(
      { command: "bun server.ts", background: true, persist_after_exit: true },
      makeContext({
        admitPersistentProcess: () => { admissionChecks += 1; return false; },
        persistentProcesses: {
          launch: async () => {
            launches += 1;
            throw new Error("persistent manager must not launch");
          },
          list: async () => [],
          read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
          stop: async () => "already_exited",
          async release() {},
          close() {},
        },
        backgroundTasks,
        foregroundBashHold,
      }),
    );

    expect(admissionChecks).toBe(1);
    expect(launches).toBe(0);
    expect(result).toEqual({
      content: "Persistent execution is disabled. Enable allow_persistent_processes or start the runtime with --allow-persistent-processes.",
      outcome: "error",
    });
    foregroundBashHold.dispose();
  });

  it("refuses a persistence request through dispatch instead of rejecting it as unknown or running it", async () => {
    const backgroundTasks = registry();
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    const disabled = await plan({ capabilities: capabilities(["background-commands"]), backgroundTasks, foregroundBashHold });
    const enabled = await plan({ capabilities: capabilities(["background-commands"]), backgroundTasks, foregroundBashHold, persistentProcesses: true });
    const effects: string[] = [];
    const context = (admitted: boolean) => makeContext({
      spawnOwned: () => { effects.push("spawn"); throw new Error("ordinary background must not launch"); },
      admitPersistentProcess: () => { effects.push("admit"); return admitted; },
      persistentProcesses: {
        launch: async () => {
          effects.push("launch");
          return { id: "persistent:test", pid: 4321, command: ["bash", "-lc", "server"], status: "running", startedAtMs: 0, stdoutBytes: 0, stderrBytes: 0, spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" } };
        },
        list: async () => [],
        read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
        stop: async () => "already_exited",
        async release() {},
        close() {},
      },
      backgroundTasks,
      foregroundBashHold,
    });
    const dispatch = (tools: typeof disabled.tools, input: { [key: string]: unknown }, admitted: boolean) =>
      executePreparedTool(prepareToolCall({ id: "call-bash", name: "bash", input }, tools, { ok: true }), context(admitted));

    expect(await dispatch(disabled.tools, { command: "bun server.ts", background: true, persist_after_exit: true }, false)).toEqual({
      content: "The persist_after_exit input of bash is unavailable to this agent now. Do not send it again.",
      outcome: "error",
    });
    expect(effects).toEqual([]);

    for (const [input, message] of [
      [{ command: "bun server.ts", background: true, bogus: true }, "An unexpected parameter `bogus` was provided"],
      [{ command: { script: "bun server.ts" } }, "`command` type is expected as `string`"],
    ] as const) {
      const malformed = await executePreparedTool(
        prepareToolCall({ id: "call-bash", name: "bash", input }, disabled.tools, { ok: true }),
        context(false),
        { gate: () => {
          effects.push("gate");
          return { kind: "replace", execute: async () => ({ content: "replaced", outcome: "ok" }) };
        } },
      );
      expect(malformed.outcome).toBe("error");
      expect(malformed.content).toContain(message);
    }
    expect(effects).toEqual([]);

    const launched = await dispatch(enabled.tools, { command: "server", background: true, persist_after_exit: true }, true);
    expect(launched.content).toContain("persistent:test");
    expect(effects).toEqual(["admit", "launch"]);
    foregroundBashHold.dispose();
  });

  it("refuses persistence when live policy evaluation fails", async () => {
    const backgroundTasks = registry();
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    const planned = await plan({ capabilities: capabilities(["background-commands"]), backgroundTasks, foregroundBashHold, persistentProcesses: true });
    const result = await planned.tools.get("bash")!.execute(
      { command: "bun server.ts", background: true, persist_after_exit: true },
      makeContext({ admitPersistentProcess: () => { throw new Error("policy unavailable"); }, backgroundTasks, foregroundBashHold }),
    );

    expect(result).toEqual({
      content: "Persistent execution is disabled. Enable allow_persistent_processes or start the runtime with --allow-persistent-processes.",
      outcome: "error",
    });
    foregroundBashHold.dispose();
  });

  it("does not widen a structural capability boundary with an unknown ceiling", () => {
    const structural: CapabilityAccess = {
      available: () => false,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), operation: request.operation, required: request.required, capabilities: request.required } }),
    };
    const granted = withCapabilityGrant(structural, {
      ...defaultModuleState(),
      operation: "unknown implementation",
      required: ["subagents"],
      capabilities: ["subagents"],
    });

    expect(granted.available("subagents")).toBe(false);
  });
});
