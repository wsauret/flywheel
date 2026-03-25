/**
 * PlanFileProvider — reads phases from a plan markdown file.
 *
 * Wraps the existing parsePlan() + state cross-reference logic
 * into the PhaseProvider interface.
 */

import * as fs from "node:fs";
import type { ParsedStateFile } from "../state/reader";
import type { PhaseInfo, PhaseProvider } from "./phase-provider";
import { parsePlan } from "./plan-parser";

// ---------------------------------------------------------------------------
// PlanFileProvider
// ---------------------------------------------------------------------------

export class PlanFileProvider implements PhaseProvider {
  private readonly planContent: string;
  private readonly state: ParsedStateFile | undefined;
  private cachedPhases: PhaseInfo[] | undefined;

  /**
   * @param planContent - Raw plan markdown content
   * @param state - Optional state file for cross-referencing phase status
   */
  constructor(planContent: string, state?: ParsedStateFile) {
    this.planContent = planContent;
    this.state = state;
  }

  /**
   * Create a PlanFileProvider by reading a plan file from disk.
   */
  static fromFile(planPath: string, state?: ParsedStateFile): PlanFileProvider {
    if (!fs.existsSync(planPath)) {
      throw new Error(`Plan file not found: ${planPath}`);
    }
    const content = fs.readFileSync(planPath, "utf-8");
    return new PlanFileProvider(content, state);
  }

  getPhases(): PhaseInfo[] {
    if (this.cachedPhases) return this.cachedPhases;

    const planPhases = parsePlan(this.planContent, this.state);
    this.cachedPhases = planPhases.map((p) => {
      const phase: PhaseInfo = {
        index: p.index,
        title: p.title,
        description: p.description,
        status: p.status,
        steps: p.steps,
      };
      if (p.milestone !== undefined) {
        phase.milestone = p.milestone;
      }
      return phase;
    });
    return this.cachedPhases;
  }

  get phaseCount(): number {
    return this.getPhases().length;
  }
}
