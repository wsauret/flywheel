import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { createSessionManager } from "../../../../src/orchestration/session/manager";
import { createStoredSession } from "./_session-metadata-test-helpers";
import { cleanupTmpRoot, makeDeps, makeDepsWithStore, makeTmpDir, minimalSession, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures";
import { workflowRunReader } from "../../../../src/orchestration/module-catalog";
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store";
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types";

afterEach(() => {
  cleanupTmpRoot();
});

// ---------------------------------------------------------------------------
// listMetadata() / listActive() / listForIds()
// ---------------------------------------------------------------------------

describe("SessionManager catalog reads", () => {
  it("returns correct data in summaries", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    await mgr.createChat({ name: "Alpha" });
    await mgr.createChat({ name: "Beta" });

    const result = await mgr.listMetadata();
    expect(result.sessions).toHaveLength(2);

    const labels = result.sessions.map((s) => s.label);
    expect(labels).toContain("Alpha");
    expect(labels).toContain("Beta");

    const names = result.sessions.map((s) => s.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
  });

  it("lists only reducer-confirmed active sessions in catalog order", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));
    const olderActive = await mgr.createChat({ name: "Older active" });
    const inactive = await mgr.createChat({ name: "Inactive" });
    const newerActive = await mgr.createChat({ name: "Newer active" });
    await mgr.updateLifecycleState(inactive, "inactive");

    const full = await mgr.listMetadata();
    const active = await mgr.listActive();
    const shared = (row: (typeof full.sessions)[number]) => ({
      id: row.id,
      label: row.label,
      lifecycleState: row.lifecycleState,
      kind: row.kind,
      command: row.command,
      lastUpdated: row.lastUpdated,
      executionCwd: row.executionCwd,
    });

    expect(active.sessions.map(shared)).toEqual(
      full.sessions.filter((row) => row.lifecycleState === "active").map(shared),
    );
    expect(active.sessions.map((row) => row.id).sort()).toEqual([newerActive, olderActive].sort());
  });

  it("handles sessions without lifecycle state gracefully", async () => {
    const baseDir = makeTmpDir();
    await createStoredSession(minimalSession({ label: "Historical chat" }), baseDir);

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = await mgr.listMetadata();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ kind: "chat", label: "Historical chat", lifecycleState: "active" });
  });

  it("listForIds includes ordinary members, titled by their phase, without runtime totals and excludes the workflow aggregate", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const mgr = createSessionManager(deps);

    const workflowId = await publishTestWorkflow(mgr, { workflowDefinitionId: "plans/active.md", name: "Active" });
    const active = await startTestWorkflowMember(mgr, store, workflowId);
    const idle = await mgr.createChat({ name: "Idle" });

    const summaries = (await mgr.listForIds([workflowId, active, idle])).sessions;
    const activeSummary = summaries.find((session) => session.id === active);
    const idleSummary = summaries.find((session) => session.id === idle);

    expect(activeSummary?.totalCost).toBeUndefined();
    expect(activeSummary?.totalTokens).toBeUndefined();
    expect(activeSummary?.contextPercent).toBeUndefined();
    // The agent of a phase of one agent takes the phase's name, as its agent line does.
    expect(activeSummary).toMatchObject({ kind: "workflow-agent", label: "fixture-step", workflowMembership: { workflowId } });
    expect(summaries.some(row => row.id === workflowId)).toBe(false);
    expect(idleSummary?.totalTokens).toBeUndefined();
    expect(idleSummary?.workflowState).toBeUndefined();

    expect(await workflowRunReader(asAsyncEventReadSurface(store)).read(workflowId)).toMatchObject({ label: "Active" });
  });

  it("lists a cold member from recoverable metadata when a later metadata row is corrupt", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const mgr = createSessionManager(deps);
    const workflowId = await publishTestWorkflow(mgr, { name: "Recoverable workflow" });
    const id = await startTestWorkflowMember(mgr, store, workflowId);
    await mgr.updateLifecycleState(id, "inactive");
    store.append({
      ...buildSessionMetadataAppend(id, {
        type: "session.auth.profile.selected",
        version: 1,
        actor: "flywheel",
        payload: { authProfileId: "profile" },
      }),
      payloadJson: "{{not-json",
    });

    const row = (await mgr.listForIds([id])).sessions[0];
    expect(row).toMatchObject({
      id,
      degraded: true,
      kind: "workflow-agent",
      lifecycleState: "inactive",
    });
    expect(row?.workflowState).toBeUndefined();
    expect(row?.unavailableFields).toContain("metadata");
    expect(await mgr.read(id)).toMatchObject({ kind: "workflow-agent", lifecycleState: "inactive" });
  });

  it("ignores corrupt artifact directories because metadata is SQLite-sourced", async () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");

    // Write a corrupt session directory (directory-per-session layout)
    const corruptDir = path.join(sessionsDir, "corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(
      path.join(corruptDir, "session.json"),
      "NOT VALID JSON",
    );

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = await mgr.listMetadata();

    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });

  it("second manager instance sees sessions from disk", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });

    // Create a second manager to read from disk
    const mgr2 = createSessionManager(makeDeps(baseDir));
    expect((await mgr2.listMetadata()).sessions.find(s => s.id === id)?.lifecycleState).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Factory function pattern
// ---------------------------------------------------------------------------

describe("createSessionManager factory", () => {
  it("two managers with different baseDirs are isolated", async () => {
    const baseDir1 = makeTmpDir();
    const baseDir2 = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir1));
    const mgr2 = createSessionManager(makeDeps(baseDir2));

    await mgr1.createChat({ name: "Isolated" });

    const result = await mgr2.listMetadata();
    expect(result.sessions).toHaveLength(0);
  });
});
