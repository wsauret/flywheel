import { describe, expect, it } from "bun:test";

import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { BackgroundOutputRequest } from "../../../../../src/orchestration/agent-runtime/background-work-processes.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { PersistentProcessRecord } from "../../../../../src/infra/persistent-process-manager.js";
import { unusedChildSessionControl } from "../../../../helpers/child-session-control.js";

const context: ToolContext = {
  executionCwd: "/repo",
  userDataRoot: "/repo/.test-account", projectRoot: "/repo",
  artifactScopeId: "process-test",
  retrievalSessionId: "process-test",
};

function deferredTask(): PromiseWithResolvers<BackgroundWorkResult> {
  return Promise.withResolvers<BackgroundWorkResult>();
}

describe("process tool", () => {
  it("lists a workflow once and exposes member session addresses in its status, not as extra child processes", async () => {
    const workflow = { id: "run-123", kind: "workflow" as const, name: "Review", state: "running" as const, addresses: ["t1 | parser | Review | running | working"] };
    const tool = createProcessTool(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }), unusedChildSessionControl({
      list: async () => [workflow],
      isChild: async (_parent, id) => id === workflow.id,
      status: async () => ({ ...workflow, progress: ["agent session: member-a | workflow run-123 | attempt attempt-a", "agent session: member-b | workflow run-123 | attempt attempt-b"] }),
    }));
    const caller = { ...context, sessionId: "parent" };
    const listed = await tool.execute({ action: "list" }, caller);
    expect(String(listed.content).match(/^- run-123 /gm)).toHaveLength(1);
    expect(listed.content).not.toContain("- member-a ");
    expect(listed.content).not.toContain("Persistent records");
    const status = await tool.execute({ action: "status", process_id: "run-123" }, caller);
    expect(status.content).toContain("agent session: member-a");
    expect(status.content).toContain("agent session: member-b");
    // The targeting rules reach an agent only beside a child's addresses; the
    // tool text names no optional capability (ARCH-CONTEXT-033).
    expect(status.content).toContain("Never substitute an agent session id for this child's process id.");
    expect(status.content).toContain("name item keys or agent ids from its status in targets for interrupt and resume");
    expect(tool.description).not.toMatch(/workflow|subagent/i);
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/workflow|subagent/i);
  });

  // An unattended chat has no list_sessions and no person who reads its transcript (PI-AGENT-121).
  it("names neither list_sessions nor the person in an unattended chat, where every other run names both", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const [attended, unattended] = [createProcessTool(registry), createProcessTool(registry, undefined, true)];
    for (const text of ["Sessions that you did not start are in list_sessions.", "The person sees each interrupt"]) {
      expect(attended.description).toContain(text);
      expect(unattended.description).not.toContain(text);
    }
    expect(unattended.description).toContain("Use one action: list returns the ids that the other actions take");
    expect((await attended.execute({ action: "list" }, context)).content).toBe("No managed processes and no children. Other sessions of this project are in list_sessions.");
    expect((await unattended.execute({ action: "list" }, context)).content).toBe("No managed processes and no children.");
  });

  it("waits at most one hour, states the duration in force for a longer estimate, and rejects invalid durations", async () => {
    const tool = createProcessTool(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
    const capped = await tool.execute({ action: "wait", soft_timeout: 7200 }, context);
    expect(capped.outcome).toBe("ok");
    expect(capped.content).toStartWith("Wait acknowledged for at most 3600 seconds. You asked for 7200 seconds; the one-hour ceiling applies.");
    const estimated = await tool.execute({ action: "wait", soft_timeout: 600 }, context);
    expect(estimated.content).toStartWith("Wait acknowledged for at most 600 seconds. If managed work is running");
    for (const soft_timeout of [0, -1, Infinity, Number.NaN, "7200"]) {
      expect((await tool.execute({ action: "wait", soft_timeout }, context)).outcome).toBe("error");
    }
  });

  it("lists commands by process ID, and lists a child only through the child controls, never from its registry record", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const tasks = ["background_command", "subagent", "workflow"].map((type, index) => {
      const done = deferredTask();
      registry.track({
        done: done.promise,
        meta: { id: `process-${index + 1}`, type, description: `${type} task`, toolUseId: `tool-${index + 1}` },
        kill: { run: () => {} },
      });
      return done;
    });
    const tool = createProcessTool(registry);

    const list = await tool.execute({ action: "list" }, context);
    expect(list.content).toContain("process-1");
    // A run with no session authority, such as a headless task, has no
    // child controls, so it lists no child.
    expect(list.content).not.toContain("process-2");
    expect(list.content).not.toContain("process-3");
    expect(list.content).not.toContain("tool-1");

    const status = await tool.execute({ action: "status", process_id: "process-2" }, context);
    expect(status.content).toContain("subagent task");
    expect(status.content).toContain("running");

    for (const done of tasks) done.resolve({ status: "completed", content: "finished" });
    await Promise.all(tasks.map((done) => done.promise));
    await Promise.resolve();

    const settled = await tool.execute({ action: "status", process_id: "process-2" }, context);
    expect(settled.content).toContain("completed");
  });

  it("stops and reads retained output by process ID after settlement", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const done = deferredTask();
    let stopSource: string | undefined;
    const requests: BackgroundOutputRequest[] = [];
    registry.track({
      done: done.promise,
      meta: { id: "build-1", type: "background_command", description: "build", toolUseId: "tool-build" },
      kill: { run: (source) => { stopSource = source; } },
      readOutput: (request) => {
        requests.push(request);
        return Promise.resolve(request.query ? "2 matching line(s):\n2: error: one\n4: error: two" : "Lines 2-3 of 4:\nerror: one\nfinish\n(1 more lines; continue with offset 3)");
      },
    });
    const tool = createProcessTool(registry);

    expect(await tool.execute({ action: "read_output", process_id: "build-1", offset: 1, limit: 2 }, context)).toMatchObject({
      outcome: "ok",
      content: expect.stringContaining("Lines 2-3 of 4"),
    });
    expect((await tool.execute({ action: "read_output", process_id: "build-1", query: "error:" }, context)).content)
      .toBe("2 matching line(s):\n2: error: one\n4: error: two");
    expect(requests).toEqual([{ offset: 1, limit: 2 }, { limit: 100, query: "error:" }]);
    expect((await tool.execute({ action: "stop", process_id: "build-1" }, context)).outcome).toBe("ok");
    expect(stopSource).toBe("agent");
    expect(await tool.execute({ action: "stop", process_id: "build-1" }, context)).toEqual({
      outcome: "ok",
      content: "A stop of process 'build-1' is already under way. It settles when the process exits.",
    });

    done.resolve({ status: "failed", content: "stopped" });
    await done.promise;
    await Promise.resolve();
    expect((await tool.execute({ action: "read_output", process_id: "build-1" }, context)).outcome).toBe("ok");
  });

  it("retains agent cancellation as a settled process", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const done = deferredTask();
    registry.track({
      done: done.promise,
      meta: { id: "cancelled-child", type: "background_command", description: "Canceled command", toolUseId: "child-tool" },
      kill: { run: (source) => {
        expect(source).toBe("agent");
        done.resolve({ status: "cancelled", content: "Canceled" });
      } },
    });
    const tool = createProcessTool(registry);
    await tool.execute({ action: "stop", process_id: "cancelled-child" }, context);
    await done.promise;
    expect(registry.processRecord("cancelled-child")?.status).toBe("cancelled");
    expect((await tool.execute({ action: "list" }, context)).content).toContain("cancelled");
    expect(await registry.waitProcess("cancelled-child", { signal: AbortSignal.abort() })).toBe(true);
  });

  it("keeps list and direct lookup bounded after settled history eviction", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const settled = Array.from({ length: 101 }, (_, index) => {
      const done = deferredTask();
      registry.track({
        done: done.promise,
        meta: { id: `history-${index}`, type: "background_command", description: `history ${index}`, toolUseId: `tool-history-${index}` },
        readOutput: () => Promise.resolve(`Lines 1-1 of 1:\noutput ${index}`),
      });
      done.resolve({ status: "completed", content: "done" });
      return done.promise;
    });
    await Promise.all(settled);
    await Promise.resolve();
    const tool = createProcessTool(registry);

    const list = await tool.execute({ action: "list" }, context);
    if (typeof list.content !== "string") throw new Error("expected process list text");
    // The header, 100 rows, and the line that names list_sessions.
    expect(list.content.split("\n")).toHaveLength(102);
    expect(list.content).not.toContain("history-0 |");
    expect(list.content).toContain("history-100 |");
    expect((await tool.execute({ action: "status", process_id: "history-0" }, context)).outcome).toBe("error");
    expect((await tool.execute({ action: "read_output", process_id: "history-100" }, context)).content).toContain("output 100");
  });

  it("acknowledges a wait, ignoring a process ID; the loop settles what the wait means", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const tool = createProcessTool(registry);
    const result = await tool.execute({ action: "wait" }, context);

    expect(result.outcome).toBe("ok");
    expect(result.content).toStartWith("Wait acknowledged for at most 240 seconds.");
    // A wait parks on every process, so a named one is acknowledged with a note, not refused.
    const named = await tool.execute({ action: "wait", process_id: "p1" }, context);
    expect(named.outcome).toBe("ok");
    expect(named.content).toStartWith("process_id is ignored: a wait parks on every process that you started. Wait acknowledged for at most 240 seconds.");
    expect((await tool.execute({ action: "wait", process_id: "p1", soft_timeout: 60 }, context)).content).toContain("Wait acknowledged for at most 60 seconds.");
    expect((await tool.execute({ action: "wait", process_id: "p1", soft_timeout: 0 }, context)).outcome).toBe("error");
  });

  it("answers a status without a process ID with the process list", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const tool = createProcessTool(registry);
    const list = await tool.execute({ action: "list" }, context);

    expect(await tool.execute({ action: "status" }, context)).toEqual(list);
    expect(await tool.execute({ action: "status", process_id: "" }, context)).toEqual(list);
    expect(await tool.execute({}, context)).toMatchObject({ outcome: "ok", content: `Note: omitted action was read as status.\n${list.content}` });
    expect(await tool.execute({ action: "stop" }, context)).toMatchObject({ outcome: "error" });
  });

  it("lists persistent metadata without reading spools and manages the record while the client is open", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const record: PersistentProcessRecord = {
      id: "persistent:server",
      pid: 42,
      command: ["bun", "run", "serve"],
      spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
      startedAtMs: Date.now() - 2_000,
      status: "running",
      stdoutBytes: 12,
      stderrBytes: 0,
    };
    const calls: string[] = [];
    const persistentProcesses = {
      launch: async () => record,
      list: async () => [record],
      read: async (_id: string, stream: "stdout" | "stderr", offset: number) => {
        calls.push(`read:${offset}`);
        const text = stream === "stdout" ? "hello\nworld" : "";
        return { data: new TextEncoder().encode(text.slice(offset)), nextOffset: text.length, eof: true };
      },
      stop: async (id: string) => { calls.push(`stop:${id}`); return "terminated" as const; },
      release: async () => {},
      close: () => {},
    };
    const persistentContext = { ...context, persistentProcesses };
    const tool = createProcessTool(registry);

    const list = await tool.execute({ action: "list" }, persistentContext);
    expect(list.content).toContain("persistent:server");
    expect(list.content).toContain("Persistent records are unavailable after host exit.");
    expect(list.content).toContain("persistent");
    expect(calls).toEqual([]);

    const status = await tool.execute({ action: "status", process_id: record.id }, persistentContext);
    expect(status.content).toContain("running");
    expect(calls).toEqual([]);

    const output = await tool.execute({ action: "read_output", process_id: record.id, limit: 1 }, persistentContext);
    expect(output.content).toContain("world");
    expect(calls[0]).toBe("read:0");

    expect((await tool.execute({ action: "stop", process_id: record.id }, persistentContext)).outcome).toBe("ok");
    expect(calls).toContain("stop:persistent:server");
  });

  it("reports an unsettled persistent stop as an ownership error", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const record: PersistentProcessRecord = {
      id: "persistent:unsettled",
      pid: 48,
      command: ["server"],
      spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
      startedAtMs: Date.now(),
      status: "running",
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const persistentProcesses = {
      launch: async () => record,
      list: async () => [record],
      read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
      stop: async () => "unsettled" as const,
      release: async () => {},
      close: () => {},
    };

    const result = await createProcessTool(registry).execute(
      { action: "stop", process_id: record.id },
      { ...context, persistentProcesses },
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Termination was not confirmed");
    expect(result.content).toContain("ownership remains managed");
  });

  it("scans a large persistent spool with bounded reads and retained output", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const bytes = new TextEncoder().encode(Array.from({ length: 30_000 }, (_, index) => `line-${index}`).join("\n"));
    const record: PersistentProcessRecord = {
      id: "persistent:scan", pid: 44, command: ["server"],
      spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
      startedAtMs: Date.now(), status: "running", stdoutBytes: bytes.byteLength, stderrBytes: 0,
    };
    const requests: number[] = [];
    const persistentProcesses = {
      launch: async () => record,
      list: async () => [record],
      read: async (_id: string, _stream: "stdout" | "stderr", offset: number, maxBytes: number) => {
        requests.push(maxBytes);
        const data = bytes.slice(offset, offset + maxBytes);
        return { data, nextOffset: offset + data.byteLength, eof: offset + data.byteLength >= bytes.byteLength };
      },
      stop: async () => "terminated" as const,
      release: async () => {},
      close: () => {},
    };

    const result = await createProcessTool(registry).execute({ action: "read_output", process_id: record.id, offset: 29_990, limit: 3 }, { ...context, persistentProcesses });
    expect(result.content).toContain("Lines 29991-29993 of 30000");
    expect(result.content.length).toBeLessThan(1_000);
    expect(requests.length).toBeGreaterThan(1);
    expect(Math.max(...requests)).toBe(64 * 1024);
  });

  it("reads persistent stderr backward before stdout and preserves combined order", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const stdout = new TextEncoder().encode("out-1\nout-2\nout-3");
    const stderr = new TextEncoder().encode("err-1\nerr-2");
    const record: PersistentProcessRecord = {
      id: "persistent:combined", pid: 45, command: ["server"],
      spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
      startedAtMs: Date.now(), status: "running", stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength,
    };
    const streams: string[] = [];
    const persistentProcesses = {
      launch: async () => record,
      list: async () => [record],
      read: async (_id: string, stream: "stdout" | "stderr", offset: number, maxBytes: number) => {
        streams.push(stream);
        const source = stream === "stdout" ? stdout : stderr;
        const data = source.slice(offset, offset + maxBytes);
        return { data, nextOffset: offset + data.byteLength, eof: offset + data.byteLength >= source.byteLength };
      },
      stop: async () => "terminated" as const,
      release: async () => {},
      close: () => {},
    };

    const result = await createProcessTool(registry).execute({ action: "read_output", process_id: record.id, limit: 3 }, { ...context, persistentProcesses });

    expect(streams[0]).toBe("stderr");
    expect(result.content).toContain("out-3\nerr-1\nerr-2");
  });

  it("keeps persistent query scanning bounded and globally numbered", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const stdout = new TextEncoder().encode("alpha\nneedle-out");
    const stderr = new TextEncoder().encode("needle-err\nomega");
    const record: PersistentProcessRecord = {
      id: "persistent:query", pid: 46, command: ["server"],
      spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
      startedAtMs: Date.now(), status: "running", stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength,
    };
    const requests: number[] = [];
    const persistentProcesses = {
      launch: async () => record,
      list: async () => [record],
      read: async (_id: string, stream: "stdout" | "stderr", offset: number, maxBytes: number) => {
        requests.push(maxBytes);
        const source = stream === "stdout" ? stdout : stderr;
        const data = source.slice(offset, offset + maxBytes);
        return { data, nextOffset: offset + data.byteLength, eof: offset + data.byteLength >= source.byteLength };
      },
      stop: async () => "terminated" as const,
      release: async () => {},
      close: () => {},
    };

    const result = await createProcessTool(registry).execute({ action: "read_output", process_id: record.id, query: "needle" }, { ...context, persistentProcesses });

    expect(result.content).toContain("2: needle-out");
    expect(result.content).toContain("3: needle-err");
    expect(Math.max(...requests)).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("process tool: persistent terminal newlines", () => {
  it("does not add a line after terminal LF, CRLF, or CR and preserves intentional blank lines", async () => {
    for (const [output, expected] of [["alpha\n", "of 1:\nalpha"], ["alpha\r\n", "of 1:\nalpha"], ["alpha\r", "of 1:\nalpha"], ["alpha\n\n", "of 2:\nalpha\n"]] as const) {
      const bytes = new TextEncoder().encode(output);
      const record: PersistentProcessRecord = {
        id: `persistent:newline-${bytes.byteLength}`, pid: 47, command: ["server"],
        spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
        startedAtMs: Date.now(), status: "running", stdoutBytes: bytes.byteLength, stderrBytes: 0,
      };
      const persistentProcesses = {
        launch: async () => record, list: async () => [record],
        read: async (_id: string, _stream: "stdout" | "stderr", offset: number, maxBytes: number) => {
          const data = bytes.slice(offset, offset + maxBytes);
          return { data, nextOffset: offset + data.byteLength, eof: offset + data.byteLength >= bytes.byteLength };
        },
        stop: async () => "terminated" as const, release: async () => {}, close: () => {},
      };

      const result = await createProcessTool(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })).execute(
        { action: "read_output", process_id: record.id, offset: 0 },
        { ...context, persistentProcesses },
      );
      expect(result.content).toContain(expected);
    }
  });
});
