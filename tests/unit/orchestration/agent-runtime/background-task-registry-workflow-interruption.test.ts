import { describe, expect, it } from "bun:test";

import type { PausedBy } from "../../../../src/infra/output-blocks.js";
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js";

describe("createBackgroundWorkRegistry (workflow interruption)", () => {
  it("reads a workflow child's interrupt from its runner at each read: a parent's or the runtime's interrupt releases the parent and only the runtime's is announced, while a person's keeps the child the parent's work in silence", () => {
    const notes: string[] = [];
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { notes.push(text); } });
    // The runner holds the one interrupt; the registry keeps no copy.
    let interruptedBy: PausedBy | undefined;
    const listeners = new Set<() => void>();
    const report = (by: typeof interruptedBy) => { interruptedBy = by; for (const listener of listeners) listener(); };
    registry.track({
      done: new Promise<never>(() => {}),
      meta: { id: "c0ffee000001", type: "workflow", description: "Review the parser" },
      interruption: { interruptedBy: () => interruptedBy, observe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    });
    expect([registry.awaitedTaskCount(), registry.waitableTaskCount()]).toEqual([1, 1]);
    expect(registry.liveWorkReferences()).toEqual([{ kind: "workflow", workflowId: "c0ffee000001" }]);

    report("agent");
    expect([registry.awaitedTaskCount(), registry.waitableTaskCount()]).toEqual([0, 0]);
    expect(registry.liveWorkReferences()).toEqual([]);
    expect(registry.assertHandoffReady()).toBeNull();
    // The parent's own call says that it interrupted the child.
    expect(notes).toEqual([]);

    report(undefined);
    expect([registry.awaitedTaskCount(), registry.waitableTaskCount()]).toEqual([1, 1]);
    // A person's interrupt and Resume do not change what the parent waits on.
    report("person");
    expect([registry.awaitedTaskCount(), registry.waitableTaskCount()]).toEqual([1, 1]);
    expect(registry.liveWorkReferences()).toEqual([{ kind: "workflow", workflowId: "c0ffee000001" }]);
    expect(registry.assertHandoffReady()).toMatchObject({ active: 1, activeDescriptions: ["Review the parser"] });
    report(undefined);
    expect(notes).toEqual([]);

    report("runtime");
    expect([registry.awaitedTaskCount(), registry.waitableTaskCount()]).toEqual([0, 0]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("The runtime interrupted this child.");
    expect(notes[0]).toContain("<session_id>c0ffee000001</session_id>");
  });
});
