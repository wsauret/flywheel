import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Session } from "../../../../src/orchestration/session/schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-session-test-${process.pid}-${Date.now()}`,
);

/** Create an isolated tmp dir for a single test. */
export function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid session data (required fields only). */
export function minimalSession(overrides?: Partial<Extract<Session, { kind: "chat" }>>): Extract<Session, { kind: "chat" }> {
  return {
    label: "plans/test.md",
    name: "",
    lifecycleState: "active" as const,
    conversationId: "test-conversation",
    executionCwd: os.tmpdir(),
    lastUpdated: new Date().toISOString(),
    kind: "chat" as const,
    command: "chat" as const,
    ...overrides,
  };
}

/** Remove the shared TMP_ROOT — call from afterEach. */
export function cleanupTmpRoot(): void {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
}
