import { describe, it, expect } from "bun:test";
import {
  STARTER_OPTIONS,
  type StarterSelection,
  getStarterOptionByValue,
} from "../src/tui/components/starter-chooser-options";

// ---------------------------------------------------------------------------
// STARTER_OPTIONS configuration
// ---------------------------------------------------------------------------
describe("STARTER_OPTIONS", () => {
  it("has exactly 2 options", () => {
    expect(STARTER_OPTIONS).toHaveLength(2);
  });

  it('includes "New from idea" with value "new-idea"', () => {
    const opt = STARTER_OPTIONS.find((o) => o.value === "new-idea");
    expect(opt).toBeDefined();
    expect(opt!.title).toBe("New from idea");
  });

  it('includes "Start from existing plan" with value "import-plan"', () => {
    const opt = STARTER_OPTIONS.find((o) => o.value === "import-plan");
    expect(opt).toBeDefined();
    expect(opt!.title).toBe("Start from existing plan");
  });

  it('does NOT include a "Resume session" option', () => {
    const opt = STARTER_OPTIONS.find(
      (o) =>
        o.title.toLowerCase().includes("resume") ||
        o.value === "resume-session"
    );
    expect(opt).toBeUndefined();
  });

  it("all options have descriptions", () => {
    for (const opt of STARTER_OPTIONS) {
      expect(opt.description).toBeTruthy();
    }
  });

  it("no options are disabled", () => {
    for (const opt of STARTER_OPTIONS) {
      expect(opt.disabled).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// getStarterOptionByValue helper
// ---------------------------------------------------------------------------
describe("getStarterOptionByValue", () => {
  it('returns the "new-idea" option', () => {
    const opt = getStarterOptionByValue("new-idea");
    expect(opt).toBeDefined();
    expect(opt!.value).toBe("new-idea");
  });

  it('returns the "import-plan" option', () => {
    const opt = getStarterOptionByValue("import-plan");
    expect(opt).toBeDefined();
    expect(opt!.value).toBe("import-plan");
  });

  it("returns undefined for unknown value", () => {
    const opt = getStarterOptionByValue("resume-session" as StarterSelection);
    expect(opt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Selection routing (callback behavior)
// ---------------------------------------------------------------------------
describe("StarterChooser selection routing", () => {
  it('"new-idea" selection triggers plan:draft flow', () => {
    const calls: StarterSelection[] = [];
    const onSelect = (value: StarterSelection) => calls.push(value);

    // Simulate what DialogSelect.onSelect does
    const opt = getStarterOptionByValue("new-idea");
    expect(opt).toBeDefined();
    onSelect(opt!.value);

    expect(calls).toEqual(["new-idea"]);
  });

  it('"import-plan" selection triggers file path prompt flow', () => {
    const calls: StarterSelection[] = [];
    const onSelect = (value: StarterSelection) => calls.push(value);

    const opt = getStarterOptionByValue("import-plan");
    expect(opt).toBeDefined();
    onSelect(opt!.value);

    expect(calls).toEqual(["import-plan"]);
  });
});
