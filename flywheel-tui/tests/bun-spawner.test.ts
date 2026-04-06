import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveSessionHandoffsDir } from "../src/infra/paths";
import { BunProcessSpawner } from "../src/orchestration/worker/bun-spawner";

describe("BunProcessSpawner", () => {
  afterEach(() => {
    const tmpRoot = path.join(os.tmpdir(), "flywheel-bun-spawner-tests");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("closes a streaming stdin session once the handoff file appears", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-bun-spawner-tests-"));
    const sessionId = "session-test";
    const handoffFileName = "plan_step-1.json";
    const handoffPath = path.join(resolveSessionHandoffsDir(sessionId, cwd), handoffFileName);

    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });

    const script = [
      'import * as fs from "node:fs";',
      'const handoffPath = process.env.HANDOFF_PATH;',
      'const reader = Bun.stdin.stream().getReader();',
      'let wrote = false;',
      'while (true) {',
      '  const { done } = await reader.read();',
      '  if (!wrote) {',
      '    fs.writeFileSync(handoffPath, JSON.stringify({ summary: "This handoff proves the worker finished planning successfully." }));',
      '    wrote = true;',
      '  }',
      '  if (done) break;',
      '}',
    ].join("\n");

    const spawner = new BunProcessSpawner({ timeoutMinutes: 1 });
    let stdinHandle: import("../src/orchestration/worker/spawner").StdinHandle | undefined;
    let turnCompleteCalls = 0;

    const spawnResult = await spawner.spawn(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, HANDOFF_PATH: handoffPath },
      stdin: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n',
      stdinPipe: true,
      sessionId,
      handoffFileName,
      onTurnComplete: () => {
        turnCompleteCalls += 1;
        stdinHandle?.close();
      },
    });

    stdinHandle = spawnResult.stdinHandle;

    const result = await spawnResult.result;

    expect(turnCompleteCalls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(handoffPath)).toBe(true);
    expect(result.handoffPath).toBe(handoffPath);
  });

  it("waits for a valid summary-bearing handoff before closing a streaming stdin session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-bun-spawner-tests-"));
    const sessionId = "session-test-summary";
    const handoffFileName = "plan_step-2.json";
    const handoffPath = path.join(resolveSessionHandoffsDir(sessionId, cwd), handoffFileName);

    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });

    const script = [
      'import * as fs from "node:fs";',
      'const handoffPath = process.env.HANDOFF_PATH;',
      'const reader = Bun.stdin.stream().getReader();',
      'let writes = 0;',
      'while (true) {',
      '  const { done } = await reader.read();',
      '  if (writes === 0) {',
      '    fs.writeFileSync(handoffPath, JSON.stringify({ decisions: ["drafted the plan"] }));',
      '    writes += 1;',
      '    setTimeout(() => {',
      '      fs.writeFileSync(handoffPath, JSON.stringify({ summary: "This handoff proves the worker finished planning successfully with a valid summary." }));',
      '    }, 200);',
      '  }',
      '  if (done) break;',
      '}',
    ].join("\n");

    const spawner = new BunProcessSpawner({ timeoutMinutes: 1 });
    let stdinHandle: import("../src/orchestration/worker/spawner").StdinHandle | undefined;
    let turnCompleteCalls = 0;

    const spawnResult = await spawner.spawn(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, HANDOFF_PATH: handoffPath },
      stdin: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n',
      stdinPipe: true,
      sessionId,
      handoffFileName,
      onTurnComplete: () => {
        turnCompleteCalls += 1;
        stdinHandle?.close();
      },
    });

    stdinHandle = spawnResult.stdinHandle;

    const result = await spawnResult.result;
    const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as { summary?: string };

    expect(turnCompleteCalls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(handoff.summary).toContain("valid summary");
  });
});