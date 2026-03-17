/**
 * FileStatePersistence — file-backed state persistence with locking.
 *
 * Extracted from WorkExecutionLoop:248-307. Manages the `.state.md` file
 * lifecycle: creation from plan content, phase status updates, and
 * atomic writes with O_EXCL locking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ParsedStateFile } from "../state/reader";
import type { StatePersistence } from "./state-persistence";
import { parseStateFile } from "../state/reader";
import { writeStateFileAtomic } from "../state/writer";
import { acquireLock } from "../state/lock";
import { parsePlan } from "./plan-parser";

// ---------------------------------------------------------------------------
// FileStatePersistence
// ---------------------------------------------------------------------------

export class FileStatePersistence implements StatePersistence {
  private readonly planPath: string;
  private readonly statePath: string;
  private readonly baseDir: string;

  constructor(planPath: string, statePath: string, baseDir: string) {
    this.planPath = planPath;
    this.statePath = statePath;
    this.baseDir = baseDir;
  }

  /**
   * Load existing state or create initial state from plan content.
   * If state file exists on disk, reads and parses it.
   * Otherwise, creates initial state from plan phases and writes it.
   */
  load(planContent: string): ParsedStateFile {
    if (fs.existsSync(this.statePath)) {
      const content = fs.readFileSync(this.statePath, "utf-8");
      return parseStateFile(content);
    }

    // Create initial state from plan
    const titles = parsePlan(planContent).map((p) => p.title);
    const state: ParsedStateFile = {
      frontmatter: {
        plan: this.planPath,
        status: "in_progress",
        schema_version: 3,
      },
      title: path.basename(this.planPath, ".md"),
      phases: titles.map((name) => ({
        name,
        status: "pending" as const,
        annotations: {},
      })),
      keyDecisions: [],
      errorLog: [],
    };

    // Write initial state
    this.writeState(state);
    return state;
  }

  /**
   * Update a phase's status and optionally append an error log entry.
   * Writes atomically with O_EXCL lock.
   */
  updatePhase(
    state: ParsedStateFile,
    phaseIndex: number,
    status: "completed" | "pending" | "in_progress",
    errorMessage?: string,
  ): void {
    if (phaseIndex < state.phases.length) {
      state.phases[phaseIndex].status = status;
    }

    if (errorMessage) {
      state.errorLog.push({
        error: errorMessage,
        attempt: String(state.errorLog.length + 1),
        approach: "controller",
        outcome: status === "completed" ? "Resolved" : "Failed",
      });
    }

    this.writeState(state);
  }

  /**
   * Get key decisions from state.
   */
  getKeyDecisions(state: ParsedStateFile): string[] {
    return state.keyDecisions;
  }

  /**
   * Write state to disk with lock.
   */
  private writeState(state: ParsedStateFile): void {
    const planName = path.basename(this.planPath, ".md");
    const lock = acquireLock(planName, this.baseDir);
    try {
      writeStateFileAtomic(this.statePath, state);
    } finally {
      lock.release();
    }
  }
}
