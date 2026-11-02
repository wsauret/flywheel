import { configSection } from "../../../../src/orchestration/config/config-section.js";
import { mcpConfigSection } from "../../../../src/orchestration/modules/mcp/config.js";
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { CONFIG_VALUE_ABSENT, createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";

const temporaryDirectory = temporaryDirectories();

function fixture() {
  const root = temporaryDirectory("runtime-config-subscription-");
  mkdirSync(join(root, ".flywheel"));
  return { root, configPath: join(root, ".flywheel", "flywheel.toml") };
}

async function waitForRevision(owner: Awaited<ReturnType<typeof createRuntimeConfigOwner>>, revision: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (owner.snapshot().revision >= revision) return;
    await Promise.resolve();
  }
  throw new Error(`Runtime config revision ${revision} was not published`);
}

describe("Runtime config subscriptions", () => {
  it("releases invoked callbacks after their last setting and snapshot registration is removed", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    async function subscribeAndRemove() {
      const captured = { bytes: new Uint8Array(1024 * 1024) };
      const weak = new WeakRef(captured);
      let calls = 0;
      const callback = () => { calls += captured.bytes.length; };
      const removeSetting = owner.subscribe("showThinking", callback);
      const removeSnapshot = owner.subscribeAll(callback);
      await owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      await removeSetting();
      const before = calls;
      await owner.mutate("showThinking", true, false);
      await removeSnapshot();
      expect(calls).toBeGreaterThan(before);
      return weak;
    }
    try {
      const weak = await subscribeAndRemove();
      // WeakRef keeps its target alive until the current task ends. JSC also
      // scans the stack conservatively, so a stale slot can hold an
      // unreachable object through one collection. Only a reference that the
      // owner keeps survives every collection.
      for (let collection = 0; collection < 5 && weak.deref() !== undefined; collection += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        Bun.gc(true);
      }
      expect(weak.deref()).toBeUndefined();
      expect(owner.snapshot().status.kind).not.toBe("disposed");
    } finally {
      await owner.dispose();
    }
  });

  it("preserves the lane when a callback registers again during unsubscribe settlement", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const revisions: number[] = [];
    const callback = async (snapshot: ReturnType<typeof owner.snapshot>) => {
      revisions.push(snapshot.revision);
      if (revisions.length === 1) {
        firstEntered.resolve();
        await firstRelease.promise;
      } else if (revisions.length === 2) {
        secondEntered.resolve();
        await secondRelease.promise;
      }
    };
    const remove = owner.subscribe("showThinking", callback);
    try {
      const first = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      await firstEntered.promise;
      const pending = owner.mutate("showThinking", true, false);
      await waitForRevision(owner, 2);
      const removal = remove();
      const removeAgain = owner.subscribeAll(callback);
      const next = owner.mutate("showThinking", false, true);
      await waitForRevision(owner, 3);
      firstRelease.resolve();
      await removal;
      await secondEntered.promise;
      const latest = owner.mutate("showThinking", true, false);
      await waitForRevision(owner, 4);
      expect(revisions).toEqual([1, 3]);
      secondRelease.resolve();
      const [firstResult, pendingResult, nextResult, latestResult] = await Promise.all([first, pending, next, latest]);
      expect(firstResult.ok && firstResult.subscriberOutcome).toEqual({ kind: "settled" });
      expect(pendingResult.ok && pendingResult.subscriberOutcome).toEqual({ kind: "committed-but-degraded", errors: ["subscriber-failed"] });
      expect(nextResult.ok && latestResult.ok).toBe(true);
      await removeAgain();
      expect(revisions).toEqual([1, 3, 4]);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await owner.dispose();
    }
  });

  it("linearizes publication before awaiting live subscriber settlement", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    let release: (() => void) | undefined;
    const subscribed = Promise.withResolvers<void>();
    owner.subscribe("showThinking", async () => new Promise<void>((resolve) => { release = resolve; subscribed.resolve(); }));
    try {
      const mutation = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      await subscribed.promise;
      expect(owner.snapshot().config.show_thinking).toBe(true);
      expect(release).toBeDefined();
      release?.();
      expect((await mutation).ok).toBe(true);
    } finally {
      await owner.dispose();
    }
  });

  it("admits unrelated source operations while one subscriber settles and preserves subscriber order", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const first = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const revisions: number[] = [];
    owner.subscribe("showThinking", async (snapshot) => {
      revisions.push(snapshot.revision);
      if (revisions.length === 1) {
        first.resolve();
        await release.promise;
      }
    });
    const one = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
    await first.promise;
    const unrelated = owner.mutate("diffColors", CONFIG_VALUE_ABSENT, "standard");
    expect((await unrelated).ok).toBe(true);
    const two = owner.mutate("showThinking", true, false);
    await Promise.resolve();
    expect(revisions).toEqual([1]);
    release.resolve();
    expect((await one).ok).toBe(true);
    expect((await two).ok).toBe(true);
    expect(revisions).toEqual([1, 3]);
    await owner.dispose();
  });

  it("coalesces 100 MCP revisions to the active and latest replacement", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const commands: string[] = [];
    owner.subscribe(mcpConfigSection, async (snapshot) => {
      const command = configSection(snapshot.config, mcpConfigSection).servers.server?.command;
      if (command !== undefined) commands.push(command);
      if (commands.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const refreshes: Promise<unknown>[] = [];
    try {
      for (let revision = 1; revision <= 100; revision += 1) {
        writeFileSync(test.configPath, `[mcp.servers.server]\ncommand = "build-${revision}"\n`);
        refreshes.push(owner.refresh());
        await waitForRevision(owner, revision);
        if (revision === 1) await entered.promise;
      }
      const unrelated = await owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      expect(unrelated.ok).toBe(true);
      expect(commands).toEqual(["build-1"]);
      let earliestSettled = false;
      let latestSettled = false;
      void refreshes[0]?.then(() => { earliestSettled = true; });
      void refreshes[99]?.then(() => { latestSettled = true; });
      await Promise.resolve();
      expect({ earliestSettled, latestSettled }).toEqual({ earliestSettled: false, latestSettled: false });
      release.resolve();
      await Promise.all(refreshes);
      expect({ earliestSettled, latestSettled }).toEqual({ earliestSettled: true, latestSettled: true });
      expect(commands).toEqual(["build-1", "build-100"]);
    } finally {
      release.resolve();
      await owner.dispose();
    }
  });

  it("settles superseded waiters with the latest failure and closes the outcome", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    owner.subscribe("showThinking", async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        return;
      }
      throw new Error("replacement failed");
    });
    try {
      const first = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      await entered.promise;
      const second = owner.mutate("showThinking", true, false);
      const third = owner.mutate("showThinking", false, true);
      await waitForRevision(owner, 3);
      release.resolve();
      const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
      expect(firstResult.ok && firstResult.subscriberOutcome).toEqual({ kind: "settled" });
      expect(secondResult.ok && secondResult.subscriberOutcome).toEqual({ kind: "committed-but-degraded", errors: ["subscriber-failed"] });
      expect(thirdResult.ok && thirdResult.subscriberOutcome).toEqual({ kind: "committed-but-degraded", errors: ["subscriber-failed"] });
      expect(calls).toBe(2);
    } finally {
      release.resolve();
      await owner.dispose();
    }
  });

  it("settles pending waiters without invoking them after unsubscribe", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const unsubscribe = owner.subscribe("showThinking", async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
    });
    try {
      const first = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
      await entered.promise;
      const pending = owner.mutate("showThinking", true, false);
      await waitForRevision(owner, 2);
      let unsubscribed = false;
      const removal = Promise.resolve(unsubscribe()).then(() => { unsubscribed = true; });
      await Promise.resolve();
      expect(unsubscribed).toBe(false);
      release.resolve();
      await removal;
      expect(unsubscribed).toBe(true);
      expect((await first).ok).toBe(true);
      const pendingResult = await pending;
      expect(pendingResult.ok && pendingResult.subscriberOutcome).toEqual({ kind: "committed-but-degraded", errors: ["subscriber-failed"] });
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await owner.dispose();
    }
  });

  it("awaits owned subscriber settlement before disposal completes", async () => {
    const test = fixture();
    const owner = await createRuntimeConfigOwner({ configPath: test.configPath, watch: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const revisions: number[] = [];
    owner.subscribe("showThinking", async (snapshot) => {
      revisions.push(snapshot.revision);
      if (revisions.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const first = owner.mutate("showThinking", CONFIG_VALUE_ABSENT, true);
    await entered.promise;
    const latest = owner.mutate("showThinking", true, false);
    await waitForRevision(owner, 2);
    let disposed = false;
    const disposal = owner.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release.resolve();
    await Promise.all([first, latest, disposal]);
    expect(disposed).toBe(true);
    expect(revisions).toEqual([1, 2]);
  });

});
