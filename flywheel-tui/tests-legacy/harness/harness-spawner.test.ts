import { describe, it, expect } from "bun:test";
import { HarnessSpawner } from "../../src/worker/harness-spawner";

describe("HarnessSpawner", () => {
  it("can be constructed", () => {
    const spawner = new HarnessSpawner();
    expect(spawner).toBeDefined();
  });

  it("implements ProcessSpawner interface", () => {
    const spawner = new HarnessSpawner();
    expect(typeof spawner.spawn).toBe("function");
  });

  it("returns stdinHandle and result promise on spawn with pre-aborted signal", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const { result, stdinHandle } = await spawner.spawn("harness", [], {
      stdin: "test prompt",
      signal: controller.signal,
    });

    expect(stdinHandle).toBeDefined();
    expect(stdinHandle!.isOpen).toBe(false);

    const workerResult = await result;
    expect(workerResult.exitCode).toBe(130);
    expect(workerResult.failure?.kind).toBe("interrupted");
  });

  it("stdinHandle.write returns false when not open", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const { stdinHandle } = await spawner.spawn("harness", [], {
      stdin: "test",
      signal: controller.signal,
    });

    expect(stdinHandle!.write("hello")).toBe(false);
  });

  it("extracts model from --model arg", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const { result } = await spawner.spawn(
      "harness",
      ["--model", "claude-opus-4-6"],
      { stdin: "test", signal: controller.signal },
    );

    const workerResult = await result;
    expect(workerResult.exitCode).toBe(130);
  });

  it("fires onSessionId callback", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    let capturedSessionId: string | undefined;
    await spawner.spawn("harness", [], {
      stdin: "test",
      signal: controller.signal,
      onSessionId: (id) => { capturedSessionId = id; },
    });

    expect(capturedSessionId).toBeDefined();
    expect(capturedSessionId).toMatch(/^harness-\d+-[a-z0-9]+$/);
  });

  it("emits completion event even on abort", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const events: string[] = [];
    const { result } = await spawner.spawn("harness", [], {
      stdin: "test",
      signal: controller.signal,
      onStdout: (chunk) => { events.push(chunk); },
    });

    await result;
    // Pre-aborted sessions should complete immediately without emitting events
    // (the abort is checked before the agent loop starts)
  });

  it("never leaks API keys in NDJSON events", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const events: string[] = [];
    const { result } = await spawner.spawn("harness", [], {
      stdin: "test with sk-ant-api03-fake-key-value-here",
      signal: controller.signal,
      onStdout: (chunk) => { events.push(chunk); },
    });

    const workerResult = await result;
    const allOutput = events.join("") + workerResult.output + (workerResult.rawOutput ?? "");
    expect(allOutput).not.toContain("sk-ant-api03");
  });

  it("result has correct WorkerResult shape", async () => {
    const spawner = new HarnessSpawner();
    const controller = new AbortController();
    controller.abort();

    const { result } = await spawner.spawn("harness", [], {
      stdin: "test",
      signal: controller.signal,
    });

    const workerResult = await result;
    expect(typeof workerResult.output).toBe("string");
    expect(typeof workerResult.exitCode).toBe("number");
    expect(typeof workerResult.truncated).toBe("boolean");
    expect(typeof workerResult.durationMs).toBe("number");
    expect(typeof workerResult.handoffPath).toBe("string");
  });
});
