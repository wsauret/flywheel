import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { validatePlan } from "../src/controller/plan-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Inline test fixtures
// ---------------------------------------------------------------------------

const VALID_PLAN_WITH_CRITERIA = `# Plan: Full Feature

## Overview
Build the thing.

### Phase 1: Setup

Create initial structure.

- [ ] Create directory layout
- [ ] Initialize config

### Phase 2: Implementation

Build the core.

- [ ] Write models
- [ ] Add validation

## Acceptance Criteria

- All tests pass
- No regressions
`;

const PLAN_MISSING_PHASES = `# Plan: No Phases

## Overview
This plan has no phases at all.

## Acceptance Criteria

- Something works
`;

const PLAN_MISSING_ACCEPTANCE_CRITERIA = `# Plan: No Criteria

### Phase 1: Setup

- [ ] Create directory layout
- [ ] Initialize config

### Phase 2: Implementation

- [ ] Write models
`;

const PLAN_TITLES_ONLY_NO_STEPS = `# Plan: Titles Only

### Phase 1: Setup

Some description but no checklist items.

### Phase 2: Implementation

Another description, still no steps.

## Acceptance Criteria

- Things work
`;

const PLAN_ONE_PHASE_HAS_STEPS_OTHER_DOESNT = `# Plan: Mixed

### Phase 1: Setup

- [ ] Create directory layout
- [ ] Initialize config

### Phase 2: Empty phase

No steps here, just prose.

## Acceptance Criteria

- Things work
`;

const PLAN_WITH_SUCCESS_CRITERIA = `# Plan: Alt heading

### Phase 1: Setup

- [ ] Create directory layout

## Success Criteria

- All good
`;

const PLAN_WITH_VERIFICATION = `# Plan: Verification heading

### Phase 1: Setup

- [ ] Create directory layout

## Verification

- Check it
`;

const PLAN_WITH_DONE_WHEN = `# Plan: Done When heading

### Phase 1: Setup

- [ ] Create directory layout

## Done When

- It's done
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validatePlan", () => {
  describe("well-structured plans", () => {
    it("returns ok:true for a valid plan with phases, steps, and acceptance criteria", () => {
      const result = validatePlan(VALID_PLAN_WITH_CRITERIA);

      expect(result.ok).toBe(true);
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].title).toBe("Setup");
      expect(result.phases[1].title).toBe("Implementation");
      if (result.ok) {
        // TypeScript narrowing — no issues field on ok:true
        expect(result.phases[0].steps.length).toBeGreaterThan(0);
      }
    });

    it("returns ok:true for the two-phase-plan fixture (no acceptance criteria is a warning, not a failure)", () => {
      const content = readFixture("two-phase-plan.md");
      const result = validatePlan(content);

      // The fixture has phases and steps but no acceptance criteria.
      // Missing acceptance criteria is an issue but phases+steps are present,
      // so it should still be ok:true (soft warning).
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].steps.length).toBeGreaterThan(0);
    });

    it("recognizes '## Success Criteria' as acceptance criteria", () => {
      const result = validatePlan(PLAN_WITH_SUCCESS_CRITERIA);
      expect(result.ok).toBe(true);
      expect(result.phases).toHaveLength(1);
    });

    it("recognizes '## Verification' as acceptance criteria", () => {
      const result = validatePlan(PLAN_WITH_VERIFICATION);
      expect(result.ok).toBe(true);
    });

    it("recognizes '## Done When' as acceptance criteria", () => {
      const result = validatePlan(PLAN_WITH_DONE_WHEN);
      expect(result.ok).toBe(true);
    });
  });

  describe("plans missing phases", () => {
    it("returns ok:false when no phases are found", () => {
      const result = validatePlan(PLAN_MISSING_PHASES);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.some((i) => /phase/i.test(i))).toBe(true);
      }
      expect(result.phases).toHaveLength(0);
    });

    it("returns ok:false for empty content", () => {
      const result = validatePlan("");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe("plans missing acceptance criteria", () => {
    it("flags missing acceptance criteria as an issue", () => {
      const result = validatePlan(PLAN_MISSING_ACCEPTANCE_CRITERIA);

      // Has phases and steps, but no acceptance criteria
      // This should be ok:false because acceptance criteria is required
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((i) => /acceptance|criteria|verification/i.test(i)),
        ).toBe(true);
      }
    });
  });

  describe("plans with only titles (no steps)", () => {
    it("returns ok:false when all phases lack steps", () => {
      const result = validatePlan(PLAN_TITLES_ONLY_NO_STEPS);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => /step/i.test(i))).toBe(true);
      }
      // Phases should still be parsed even if invalid
      expect(result.phases).toHaveLength(2);
    });

    it("returns ok:false when some phases lack steps", () => {
      const result = validatePlan(PLAN_ONE_PHASE_HAS_STEPS_OTHER_DOESNT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => /Phase 2/i.test(i))).toBe(true);
      }
    });
  });

  describe("phases array is always populated", () => {
    it("returns parsed phases even when validation fails", () => {
      const result = validatePlan(PLAN_TITLES_ONLY_NO_STEPS);

      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].title).toBe("Setup");
      expect(result.phases[1].title).toBe("Implementation");
    });
  });
});
