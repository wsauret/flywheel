/**
 * Session Header Derivation Tests (Step 5, Step 5.0)
 *
 * Tests the mapping from SessionLifecycleState → WorkflowStatus,
 * and the derivation of SessionHeaderInfo from SessionSummary.
 *
 * TDD: Written before the implementation function exists.
 */

import { describe, it, expect } from "bun:test";
import {
  lifecycleToWorkflowStatus,
  deriveHeaderInfo,
} from "../src/tui/components/session-header-logic";
import type { SessionSummary } from "../src/session/manager";
import type { SessionLifecycleState } from "../src/session/state-machine";

// ---------------------------------------------------------------------------
// lifecycleToWorkflowStatus
// ---------------------------------------------------------------------------

describe("lifecycleToWorkflowStatus", () => {
  it("maps work:active to running", () => {
    expect(lifecycleToWorkflowStatus("work:active")).toBe("running");
  });

  it("maps work:paused to interrupted", () => {
    expect(lifecycleToWorkflowStatus("work:paused")).toBe("interrupted");
  });

  it("maps completed to completed", () => {
    expect(lifecycleToWorkflowStatus("completed")).toBe("completed");
  });

  it("maps work:review to running", () => {
    expect(lifecycleToWorkflowStatus("work:review")).toBe("running");
  });

  it("maps archived to completed", () => {
    expect(lifecycleToWorkflowStatus("archived")).toBe("completed");
  });

  it("maps trashed to completed", () => {
    expect(lifecycleToWorkflowStatus("trashed")).toBe("completed");
  });

  it("maps plan states to idle", () => {
    const planStates: SessionLifecycleState[] = [
      "new",
      "plan:draft",
      "plan:imported",
      "plan:approved",
      "plan:needs-fix",
    ];
    for (const state of planStates) {
      expect(lifecycleToWorkflowStatus(state)).toBe("idle");
    }
  });
});

// ---------------------------------------------------------------------------
// deriveHeaderInfo
// ---------------------------------------------------------------------------

describe("deriveHeaderInfo", () => {
  const baseSummary: SessionSummary = {
    id: "test-id",
    name: "Test Session",
    label: "Test Session",
    planPath: "plans/feature.md",
    lifecycleState: "completed",
    totalCost: 0.42,
    lastUpdated: "2026-01-15T10:30:00.000Z",
  };

  it("derives sessionName from summary name", () => {
    const info = deriveHeaderInfo(baseSummary);
    expect(info.sessionName).toBe("Test Session");
  });

  it("derives planName from summary planPath", () => {
    const info = deriveHeaderInfo(baseSummary);
    expect(info.planName).toBe("plans/feature.md");
  });

  it("derives workflowStatus from lifecycle state", () => {
    const info = deriveHeaderInfo(baseSummary);
    expect(info.workflowStatus).toBe("completed");
  });

  it("derives interrupted status for paused sessions", () => {
    const paused = { ...baseSummary, lifecycleState: "work:paused" as const };
    const info = deriveHeaderInfo(paused);
    expect(info.workflowStatus).toBe("interrupted");
  });

  it("derives idle status for plan-stage sessions", () => {
    const planDraft = { ...baseSummary, lifecycleState: "plan:draft" as const };
    const info = deriveHeaderInfo(planDraft);
    expect(info.workflowStatus).toBe("idle");
  });

  it("falls back to label when name is empty", () => {
    const noName = { ...baseSummary, name: "" };
    const info = deriveHeaderInfo(noName);
    expect(info.sessionName).toBe("Test Session");
  });

  it("does NOT set startTime to Date.now() (must not call workflowStarted)", () => {
    // This verifies the critical constraint: historical sessions should not
    // have their startTime set to the current time. The header derivation
    // returns no startTime — the store's default is used, or the shell
    // directly sets startTime from session metadata.
    const info = deriveHeaderInfo(baseSummary);
    // The returned info should not have a startTime property at all
    // (WorkflowStatus derivation is separate from time tracking)
    expect(info).not.toHaveProperty("startTime");
  });
});
