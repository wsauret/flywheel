import { describe, it, expect } from "bun:test";
import { DEFAULT_TOOL_SCOPING, resolveToolScoping } from "../src/controller/tool-scoping";
import type { StepType } from "../src/controller/queue-types";
import type { ToolScoping } from "../src/schemas/shared";

// ---------------------------------------------------------------------------
// DEFAULT_TOOL_SCOPING
// ---------------------------------------------------------------------------

describe("DEFAULT_TOOL_SCOPING", () => {
  it("work steps get full access by default", () => {
    expect(DEFAULT_TOOL_SCOPING.work).toEqual({
      read: true, bash: true, write: true, edit: true,
    });
  });

  it("plan steps get read-only by default (read + bash)", () => {
    expect(DEFAULT_TOOL_SCOPING.plan).toEqual({
      read: true, bash: true, write: false, edit: false,
    });
  });

  it("review steps get read-only by default (read + bash)", () => {
    expect(DEFAULT_TOOL_SCOPING.review).toEqual({
      read: true, bash: true, write: false, edit: false,
    });
  });

  it("research steps get read-only by default (read + bash)", () => {
    expect(DEFAULT_TOOL_SCOPING.research).toEqual({
      read: true, bash: true, write: false, edit: false,
    });
  });

  it("ship steps get write + bash (git ops)", () => {
    expect(DEFAULT_TOOL_SCOPING.ship).toEqual({
      read: true, bash: true, write: true, edit: false,
    });
  });

  it("debug steps get full access", () => {
    expect(DEFAULT_TOOL_SCOPING.debug).toEqual({
      read: true, bash: true, write: true, edit: true,
    });
  });

  it("covers all StepType values", () => {
    const allTypes: StepType[] = ["work", "plan", "review", "ship", "debug", "research", "verify", "gate"];
    for (const wfType of allTypes) {
      expect(DEFAULT_TOOL_SCOPING[wfType]).toBeDefined();
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].read).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].bash).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].write).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].edit).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// resolveToolScoping
// ---------------------------------------------------------------------------

describe("resolveToolScoping", () => {
  it("returns default scoping when no override provided", () => {
    expect(resolveToolScoping("work")).toEqual(DEFAULT_TOOL_SCOPING.work);
    expect(resolveToolScoping("plan")).toEqual(DEFAULT_TOOL_SCOPING.plan);
    expect(resolveToolScoping("review")).toEqual(DEFAULT_TOOL_SCOPING.review);
  });

  it("dispatcher-provided scoping overrides defaults", () => {
    const override: ToolScoping = { read: true, bash: false, write: false, edit: false };
    expect(resolveToolScoping("work", override)).toEqual(override);
  });

  it("dispatcher override applies even to restrictive workflow types", () => {
    // Plan normally restricts write/edit, but dispatcher can override
    const override: ToolScoping = { read: true, bash: true, write: true, edit: true };
    expect(resolveToolScoping("plan", override)).toEqual(override);
  });

  it("returns default when override is undefined", () => {
    expect(resolveToolScoping("ship", undefined)).toEqual(DEFAULT_TOOL_SCOPING.ship);
  });
});
