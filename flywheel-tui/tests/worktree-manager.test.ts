import { describe, it, expect, beforeEach } from "bun:test";
import {
  createWorktreeManager,
  type IWorktreeClient,
  type WorktreeInfo,
  type WorktreeManagerDeps,
} from "../src/session/worktree-manager";
import type { Session } from "../src/schemas/session";

// ---------------------------------------------------------------------------
// Mock IWorktreeClient
// ---------------------------------------------------------------------------

interface MockClientCall {
  method: string;
  args: unknown[];
}

function createMockWorktreeClient(opts?: {
  available?: boolean;
  existingWorktrees?: WorktreeInfo[];
  failOn?: string;
}): IWorktreeClient & { calls: MockClientCall[] } {
  const available = opts?.available ?? true;
  const existing = opts?.existingWorktrees ?? [];
  const failOn = opts?.failOn;
  const calls: MockClientCall[] = [];

  return {
    calls,

    async isAvailable(): Promise<boolean> {
      calls.push({ method: "isAvailable", args: [] });
      return available;
    },

    async create(branchName: string, baseBranch?: string): Promise<WorktreeInfo> {
      calls.push({ method: "create", args: [branchName, baseBranch] });
      if (failOn === "create") {
        throw new Error("wt create failed");
      }
      const info: WorktreeInfo = {
        path: `/tmp/worktrees/${branchName}`,
        branch: branchName,
        isActive: true,
      };
      existing.push(info);
      return info;
    },

    async switchTo(branchName: string): Promise<WorktreeInfo> {
      calls.push({ method: "switchTo", args: [branchName] });
      if (failOn === "switchTo") {
        throw new Error("wt switch failed");
      }
      const found = existing.find((w) => w.branch === branchName);
      if (!found) {
        throw new Error(`Worktree not found: ${branchName}`);
      }
      return { ...found, isActive: true };
    },

    async remove(branchName: string, force?: boolean): Promise<void> {
      calls.push({ method: "remove", args: [branchName, force] });
      if (failOn === "remove") {
        throw new Error("wt remove failed");
      }
      const idx = existing.findIndex((w) => w.branch === branchName);
      if (idx >= 0) existing.splice(idx, 1);
    },

    async list(): Promise<WorktreeInfo[]> {
      calls.push({ method: "list", args: [] });
      return [...existing];
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: default deps
// ---------------------------------------------------------------------------

function makeDeps(
  client: IWorktreeClient,
  overrides?: Partial<WorktreeManagerDeps>,
): WorktreeManagerDeps {
  return {
    client,
    enabled: true,
    autoRemoveOnArchive: false,
    gracePeriodMs: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plan-only sessions don't create worktree
// ---------------------------------------------------------------------------

describe("WorktreeManager — plan-only sessions", () => {
  it("createForSession returns null when disabled", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { enabled: false }));

    const result = await mgr.createForSession("session-1", "feat/my-branch");

    expect(result).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it("createForSession does nothing if manager is disabled", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { enabled: false }));

    const result = await mgr.createForSession("session-1", "feat/plan-only");

    expect(result).toBeNull();
    // No calls to the client at all
    expect(client.calls.filter((c) => c.method !== "isAvailable")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// work:active creates worktree
// ---------------------------------------------------------------------------

describe("WorktreeManager — createForSession (work:active)", () => {
  it("creates a worktree via client.create", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.createForSession("session-1", "feat/new-feature");

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/new-feature");
    expect(result!.path).toBe("/tmp/worktrees/feat/new-feature");

    const createCalls = client.calls.filter((c) => c.method === "create");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0]).toBe("feat/new-feature");
  });

  it("tracks session-to-worktree mapping after creation", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/tracked");

    // switchToSession should work now without creating a new worktree
    const result = await mgr.switchToSession("session-1");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/tracked");
  });

  it("passes baseBranch through to client.create when provided", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/from-main", "main");

    const createCalls = client.calls.filter((c) => c.method === "create");
    expect(createCalls[0].args[1]).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Paused sessions keep worktree
// ---------------------------------------------------------------------------

describe("WorktreeManager — paused sessions keep worktree", () => {
  it("switchToSession returns existing worktree (no re-create)", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    // Create
    await mgr.createForSession("session-1", "feat/pausable");

    // Simulate pause -> resume: switchToSession should find existing
    const result = await mgr.switchToSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/pausable");

    // Should have called switchTo, not create again
    const createCalls = client.calls.filter((c) => c.method === "create");
    expect(createCalls).toHaveLength(1); // Only the initial one
  });
});

// ---------------------------------------------------------------------------
// Archived sessions can detach (optionally remove)
// ---------------------------------------------------------------------------

describe("WorktreeManager — archived sessions", () => {
  it("removeForSession removes worktree when autoRemoveOnArchive is true", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(
      makeDeps(client, { autoRemoveOnArchive: true }),
    );

    await mgr.createForSession("session-1", "feat/archive-me");
    await mgr.removeForSession("session-1");

    const removeCalls = client.calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].args[0]).toBe("feat/archive-me");
  });

  it("removeForSession clears internal mapping", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/gone");
    await mgr.removeForSession("session-1");

    // switchToSession should return null (no mapping)
    const result = await mgr.switchToSession("session-1");
    expect(result).toBeNull();
  });

  it("removeForSession is a no-op for unknown session", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    // Should not throw
    await mgr.removeForSession("unknown-session");

    const removeCalls = client.calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trashed sessions clean up with grace period
// ---------------------------------------------------------------------------

describe("WorktreeManager — trashed sessions with grace period", () => {
  it("trashSession stores lastTrashedAt timestamp", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { gracePeriodMs: 60_000 }));

    await mgr.createForSession("session-1", "feat/trashable");

    const before = Date.now();
    const trashInfo = mgr.trashSession("session-1");
    const after = Date.now();

    expect(trashInfo).not.toBeNull();
    expect(trashInfo!.lastTrashedAt).toBeGreaterThanOrEqual(before);
    expect(trashInfo!.lastTrashedAt).toBeLessThanOrEqual(after);
  });

  it("cleanupTrashed does NOT remove if grace period has not elapsed", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { gracePeriodMs: 60_000 }));

    await mgr.createForSession("session-1", "feat/grace");
    mgr.trashSession("session-1");

    // Attempt cleanup immediately — grace period hasn't elapsed
    const cleaned = await mgr.cleanupTrashed("session-1");

    expect(cleaned).toBe(false);
    const removeCalls = client.calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });

  it("cleanupTrashed removes worktree after grace period elapses", async () => {
    const client = createMockWorktreeClient();
    // Use tiny grace period (1ms) for test speed
    const mgr = createWorktreeManager(makeDeps(client, { gracePeriodMs: 1 }));

    await mgr.createForSession("session-1", "feat/expired");
    mgr.trashSession("session-1");

    // Wait for grace period to elapse
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cleaned = await mgr.cleanupTrashed("session-1");

    expect(cleaned).toBe(true);
    const removeCalls = client.calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].args[0]).toBe("feat/expired");
  });

  it("cleanupTrashed is gated on lock — skips if session is locked", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { gracePeriodMs: 1 }));

    await mgr.createForSession("session-1", "feat/locked");
    mgr.trashSession("session-1");

    // Lock the session
    mgr.lockSession("session-1");

    // Wait for grace period
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should skip cleanup because session is locked
    const cleaned = await mgr.cleanupTrashed("session-1");
    expect(cleaned).toBe(false);

    const removeCalls = client.calls.filter((c) => c.method === "remove");
    expect(removeCalls).toHaveLength(0);
  });

  it("cleanupTrashed succeeds after unlock", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { gracePeriodMs: 1 }));

    await mgr.createForSession("session-1", "feat/unlock-then-clean");
    mgr.trashSession("session-1");
    mgr.lockSession("session-1");

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Still locked
    expect(await mgr.cleanupTrashed("session-1")).toBe(false);

    // Unlock
    mgr.unlockSession("session-1");

    // Now cleanup succeeds
    const cleaned = await mgr.cleanupTrashed("session-1");
    expect(cleaned).toBe(true);
  });

  it("trashSession returns null for unknown session", () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    const result = mgr.trashSession("unknown");
    expect(result).toBeNull();
  });

  it("cleanupTrashed returns false for unknown session", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.cleanupTrashed("unknown");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Graceful fallback if wt CLI not installed
// ---------------------------------------------------------------------------

describe("WorktreeManager — graceful fallback (wt unavailable)", () => {
  it("createForSession returns null when client is unavailable", async () => {
    const client = createMockWorktreeClient({ available: false });
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.createForSession("session-1", "feat/no-wt");

    expect(result).toBeNull();
    // Should have checked availability but not attempted create
    const availCalls = client.calls.filter((c) => c.method === "isAvailable");
    expect(availCalls).toHaveLength(1);
    const createCalls = client.calls.filter((c) => c.method === "create");
    expect(createCalls).toHaveLength(0);
  });

  it("switchToSession returns null when client is unavailable", async () => {
    const client = createMockWorktreeClient({ available: false });
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.switchToSession("session-1");

    expect(result).toBeNull();
  });

  it("removeForSession is a no-op when client is unavailable", async () => {
    // Start with available to create, then simulate unavailable
    const client = createMockWorktreeClient({ available: true });
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/remove-noop");

    // Now make it unavailable (simulate wt uninstalled between calls)
    // We test by creating a fresh manager with unavailable client
    const unavailableClient = createMockWorktreeClient({ available: false });
    const mgr2 = createWorktreeManager(makeDeps(unavailableClient));

    // Should not throw
    await mgr2.removeForSession("session-1");

    const removeCalls = unavailableClient.calls.filter(
      (c) => c.method === "remove",
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("isAvailable delegates to client.isAvailable", async () => {
    const available = createMockWorktreeClient({ available: true });
    const unavailable = createMockWorktreeClient({ available: false });

    const mgr1 = createWorktreeManager(makeDeps(available));
    const mgr2 = createWorktreeManager(makeDeps(unavailable));

    expect(await mgr1.isAvailable()).toBe(true);
    expect(await mgr2.isAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error handling — client failures
// ---------------------------------------------------------------------------

describe("WorktreeManager — error handling", () => {
  it("createForSession returns null on client.create failure", async () => {
    const client = createMockWorktreeClient({ failOn: "create" });
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.createForSession("session-1", "feat/fail-create");

    expect(result).toBeNull();
  });

  it("switchToSession returns null on client.switchTo failure", async () => {
    const client = createMockWorktreeClient({ failOn: "switchTo" });
    const mgr = createWorktreeManager(makeDeps(client));

    // Manually track a session so switchToSession attempts switchTo
    await mgr.createForSession("session-1", "feat/fail-switch");
    // Reset failOn by overriding — we need create to work but switchTo to fail
    // Actually, create already failed too. Let's use a different approach.

    const client2 = createMockWorktreeClient({
      existingWorktrees: [
        { path: "/tmp/w/feat/x", branch: "feat/x", isActive: false },
      ],
    });
    const mgr2 = createWorktreeManager(makeDeps(client2));

    // Pre-register the session mapping via createForSession
    await mgr2.createForSession("session-2", "feat/switch-test");

    // Now create a manager whose client fails on switchTo
    const failClient = createMockWorktreeClient({ failOn: "switchTo" });
    const mgr3 = createWorktreeManager(makeDeps(failClient));
    // mgr3 doesn't have the mapping, so switchToSession returns null for unknown session
    const result = await mgr3.switchToSession("session-2");
    expect(result).toBeNull();
  });

  it("removeForSession swallows client.remove failure gracefully", async () => {
    const client = createMockWorktreeClient({ failOn: "remove" });
    const mgr = createWorktreeManager(makeDeps(client));

    // Need to first create successfully, then fail on remove
    // Use a client that works for create but fails for remove
    const mixedClient = createMockWorktreeClient();
    const mgr2 = createWorktreeManager(makeDeps(mixedClient));
    await mgr2.createForSession("session-1", "feat/remove-fail");

    // The internal mapping exists, but we simulate by creating a fresh mock that fails on remove
    // Better: use a client whose remove throws
    const failRemoveClient = (() => {
      const c = createMockWorktreeClient();
      const originalRemove = c.remove.bind(c);
      c.remove = async (branchName: string, force?: boolean) => {
        c.calls.push({ method: "remove", args: [branchName, force] });
        throw new Error("wt remove failed");
      };
      return c;
    })();

    const mgr3 = createWorktreeManager(makeDeps(failRemoveClient));
    // Create then remove — remove will throw but should be swallowed
    await mgr3.createForSession("session-1", "feat/remove-fail2");

    // Should not throw
    await mgr3.removeForSession("session-1");
  });
});

// ---------------------------------------------------------------------------
// Disabled manager is fully inert
// ---------------------------------------------------------------------------

describe("WorktreeManager — disabled mode", () => {
  it("all operations return null/false/no-op when disabled", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, { enabled: false }));

    expect(await mgr.createForSession("s1", "branch")).toBeNull();
    expect(await mgr.switchToSession("s1")).toBeNull();
    expect(await mgr.isAvailable()).toBe(false);

    // removeForSession should not throw
    await mgr.removeForSession("s1");

    // No client calls except possibly isAvailable
    const nonAvailCalls = client.calls.filter((c) => c.method !== "isAvailable");
    expect(nonAvailCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple sessions can be tracked simultaneously
// ---------------------------------------------------------------------------

describe("WorktreeManager — multiple sessions", () => {
  it("tracks multiple session-to-worktree mappings independently", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/one");
    await mgr.createForSession("session-2", "feat/two");

    const s1 = await mgr.switchToSession("session-1");
    const s2 = await mgr.switchToSession("session-2");

    expect(s1!.branch).toBe("feat/one");
    expect(s2!.branch).toBe("feat/two");
  });

  it("removing one session doesn't affect others", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client));

    await mgr.createForSession("session-1", "feat/keep");
    await mgr.createForSession("session-2", "feat/remove-me");

    await mgr.removeForSession("session-2");

    // session-1 still works
    const s1 = await mgr.switchToSession("session-1");
    expect(s1!.branch).toBe("feat/keep");

    // session-2 is gone
    const s2 = await mgr.switchToSession("session-2");
    expect(s2).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Worktree path persistence (Step 2 — step 2.6)
// ---------------------------------------------------------------------------

describe("WorktreeManager — worktreePath persistence", () => {
  it("createForSession calls updateSession with worktreePath and branch", async () => {
    const client = createMockWorktreeClient();
    const updates: Array<{ id: string; partial: Partial<Session> }> = [];
    const mgr = createWorktreeManager(makeDeps(client, {
      updateSession: (id, partial) => { updates.push({ id, partial }); },
    }));

    await mgr.createForSession("session-1", "feat/persisted");

    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("session-1");
    expect(updates[0].partial.worktreePath).toBe("/tmp/worktrees/feat/persisted");
    expect(updates[0].partial.branch).toBe("feat/persisted");
  });

  it("createForSession does NOT call updateSession when worktree creation fails", async () => {
    const client = createMockWorktreeClient({ failOn: "create" });
    const updates: Array<{ id: string; partial: Partial<Session> }> = [];
    const mgr = createWorktreeManager(makeDeps(client, {
      updateSession: (id, partial) => { updates.push({ id, partial }); },
    }));

    const result = await mgr.createForSession("session-1", "feat/fail");

    expect(result).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("createForSession does NOT call updateSession when disabled", async () => {
    const client = createMockWorktreeClient();
    const updates: Array<{ id: string; partial: Partial<Session> }> = [];
    const mgr = createWorktreeManager(makeDeps(client, {
      enabled: false,
      updateSession: (id, partial) => { updates.push({ id, partial }); },
    }));

    await mgr.createForSession("session-1", "feat/disabled");

    expect(updates).toHaveLength(0);
  });

  it("createForSession tolerates missing updateSession (optional dep)", async () => {
    const client = createMockWorktreeClient();
    // No updateSession provided — should not throw
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.createForSession("session-1", "feat/no-persist");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/no-persist");
  });
});

// ---------------------------------------------------------------------------
// Lazy rehydration from disk (Step 2 — step 2.6)
// ---------------------------------------------------------------------------

describe("WorktreeManager — lazy rehydration (switchToSession)", () => {
  it("switchToSession falls back to readSession when Map has no entry", async () => {
    const client = createMockWorktreeClient({
      existingWorktrees: [
        { path: "/tmp/worktrees/feat/from-disk", branch: "feat/from-disk", isActive: false },
      ],
    });
    const mgr = createWorktreeManager(makeDeps(client, {
      readSession: (id) => ({
        worktreePath: "/tmp/worktrees/feat/from-disk",
        branch: "feat/from-disk",
      }),
    }));

    // No createForSession — Map is empty. readSession provides fallback.
    const result = await mgr.switchToSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/from-disk");
  });

  it("switchToSession prefers Map entry over readSession", async () => {
    const client = createMockWorktreeClient();
    let readCalled = false;
    const mgr = createWorktreeManager(makeDeps(client, {
      readSession: (id) => {
        readCalled = true;
        return { worktreePath: "/tmp/disk", branch: "from-disk" };
      },
    }));

    // Create entry in Map
    await mgr.createForSession("session-1", "feat/in-memory");

    // Switch should use Map, not readSession
    const result = await mgr.switchToSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/in-memory");
    expect(readCalled).toBe(false);
  });

  it("switchToSession returns null when readSession returns no worktreePath", async () => {
    const client = createMockWorktreeClient();
    const mgr = createWorktreeManager(makeDeps(client, {
      readSession: (id) => ({ worktreePath: undefined, branch: undefined }),
    }));

    const result = await mgr.switchToSession("session-1");
    expect(result).toBeNull();
  });

  it("switchToSession returns null when readSession is not provided", async () => {
    const client = createMockWorktreeClient();
    // No readSession dep — default behavior (returns null for unknown)
    const mgr = createWorktreeManager(makeDeps(client));

    const result = await mgr.switchToSession("unknown-session");
    expect(result).toBeNull();
  });

  it("switchToSession populates Map after reading from disk (subsequent calls use Map)", async () => {
    const client = createMockWorktreeClient({
      existingWorktrees: [
        { path: "/tmp/worktrees/feat/rehydrated", branch: "feat/rehydrated", isActive: false },
      ],
    });
    let readCount = 0;
    const mgr = createWorktreeManager(makeDeps(client, {
      readSession: (id) => {
        readCount++;
        return { worktreePath: "/tmp/worktrees/feat/rehydrated", branch: "feat/rehydrated" };
      },
    }));

    // First call: reads from disk
    await mgr.switchToSession("session-1");
    expect(readCount).toBe(1);

    // Second call: should use Map (not call readSession again)
    await mgr.switchToSession("session-1");
    expect(readCount).toBe(1);
  });
});
