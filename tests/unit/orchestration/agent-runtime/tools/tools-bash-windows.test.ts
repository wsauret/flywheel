import { describe, expect, it } from "bun:test";
import * as os from "node:os";

import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { backgroundLogPath } from "../../../../helpers/background-log-path.js";
import { makeMockOps, makeMockOwnedProcess, ownedSpawnProbe } from "./_bash-fixtures.js";
import { capabilityAccessHolding, makeContext } from "./_fixtures.js";
import type { PersistentProcessClient, PersistentProcessRecord } from "../../../../../src/infra/persistent-process-manager.js";

describe("bash tool: Windows shell execution", () => {
  const availableTools = new Set(["edit", "write"]);
  it("uses PowerShell scripts for foreground commands", async () => {
    const writeCalls: { path: string; content: string }[] = [];
    const spawn = ownedSpawnProbe();

    const def = createBashDefinition({
      platform: "win32",
      tmpDir: os.tmpdir(),
      operations: makeMockOps({
        writeScript: async (p, content) => {
          writeCalls.push({ path: p, content });
          return content.length;
        },
      }),
    });

    const result = await def.execute({ command: "Write-Output hello" }, makeContext({ executionCwd: os.tmpdir(), spawnOwned: spawn.spawnOwned, availableTools }));

    expect(result.outcome).toBe("ok");
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]!.path.endsWith(".ps1")).toBe(true);
    expect(writeCalls[0]!.content).toContain("Write-Output hello");
    expect(writeCalls[0]!.content).toContain("} *>&1");
    expect(spawn.launches[0]!.cmd.slice(0, 5)).toEqual(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  });

  // `powershell.exe -File` exits 0 after a script that ends without `exit`,
  // so a held command reported success for every failed native program.
  it("records every stream of a held foreground command and carries its native exit code", async () => {
    const writeCalls: string[] = [];
    const spawn = ownedSpawnProbe();
    const def = createBashDefinition({
      platform: "win32",
      tmpDir: os.tmpdir(),
      operations: makeMockOps({
        writeScript: async (_path, content) => {
          writeCalls.push(content);
          return content.length;
        },
      }),
    });

    const result = await def.execute({ command: "cmd /c exit 3" }, makeContext({
      executionCwd: os.tmpdir(),
      spawnOwned: spawn.spawnOwned,
      availableTools,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }),
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      toolUseId: "toolu_windows_held",
    }));

    expect(result.outcome).toBe("ok");
    const script = writeCalls[0] ?? "";
    const logPath = backgroundLogPath(script);
    expect(logPath).toBeDefined();
    expect(script).toContain("& {\ncmd /c exit 3\n} *>&1 | ForEach-Object { $flywheelLog.WriteLine([string]$_) }");
    expect(script).toContain("$nativeExitCode = $global:LASTEXITCODE");
    expect(script.endsWith([
      "if ($nativeExitCode -ne $null) { exit $nativeExitCode }",
      "if ($success) { exit 0 }",
      "exit 1",
    ].join("\n"))).toBe(true);
  });

  it("starts background commands through PowerShell", async () => {
    const writeCalls: { path: string; content: string }[] = [];
    const spawn = ownedSpawnProbe(() => makeMockOwnedProcess({ pid: 777 }));
    const ctx = makeContext({ executionCwd: os.tmpdir(), spawnOwned: spawn.spawnOwned, capabilityAccess: capabilityAccessHolding(["background-commands"]), backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification() {} }), availableTools });
    const def = createBashDefinition({
      platform: "win32",
      tmpDir: os.tmpdir(),
      operations: makeMockOps({
        writeScript: async (p, content) => {
          writeCalls.push({ path: p, content });
          return content.length;
        },
      }),
    });

    const result = await def.execute({ command: "Start-Sleep 60", background: true }, ctx);

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("managed process");
    expect(spawn.launches[0]!.cmd[0]).toBe("powershell.exe");
    expect(writeCalls[0]!.path.endsWith(".ps1")).toBe(true);
    expect(writeCalls[0]!.content).toContain("Start-Sleep 60");
  });

  it("uses the platform shell authority for persistent commands", async () => {
    const launched: string[][] = [];
    const record: PersistentProcessRecord = {
      id: "persistent:windows",
      pid: 778,
      command: [],
      spool: { directory: os.tmpdir(), stdoutPath: os.tmpdir(), stderrPath: os.tmpdir() },
      startedAtMs: Date.now(),
      status: "running",
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    const persistentProcesses: PersistentProcessClient = {
      launch: async (command) => { launched.push([...command]); return { ...record, command: [...command] }; },
      list: async () => [record],
      read: async () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
      stop: async () => "terminated",
      release: async () => {},
      close: () => {},
    };
    const def = createBashDefinition({ platform: "win32", persistentProcesses: true });

    const result = await def.execute(
      { command: "Start-Sleep 60", background: true, persist_after_exit: true },
      makeContext({ persistentProcesses, admitPersistentProcess: () => true, availableTools }),
    );

    expect(result.outcome).toBe("ok");
    expect(launched[0]?.slice(0, 3)).toEqual(["powershell.exe", "-NoProfile", "-Command"]);
    expect(launched[0]?.some((argument) => argument.includes("Start-Sleep 60"))).toBe(true);
  });
});
