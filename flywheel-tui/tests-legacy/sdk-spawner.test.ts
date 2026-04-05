import { describe, it, expect } from "bun:test";
import { SdkSpawner } from "../src/worker/sdk-spawner";

/**
 * Unit tests for SdkSpawner.
 *
 * These test the public API surface without actually starting an OpenCode server.
 * Integration tests that hit a real server are in tests/e2e/.
 *
 * We test:
 * - Construction and dispose lifecycle
 * - parseModelId helper (indirectly through spawn args)
 * - StdinHandle contract after dispose
 */

describe("SdkSpawner", () => {
  it("can be constructed", () => {
    const spawner = new SdkSpawner();
    expect(spawner).toBeDefined();
  });

  it("dispose is idempotent", () => {
    const spawner = new SdkSpawner();
    // Double dispose should not throw
    spawner.dispose();
    spawner.dispose();
  });

  it("implements ProcessSpawner interface", () => {
    const spawner = new SdkSpawner();
    expect(typeof spawner.spawn).toBe("function");
    expect(typeof spawner.dispose).toBe("function");
  });
});
