// ---------------------------------------------------------------------------
// Gate Step Handler
// ---------------------------------------------------------------------------
//
// Handles gate-type steps by presenting a question to the user via the
// QuestionService (continue/stop/pause). When no QuestionService is
// available, auto-resolves as "continue".
// ---------------------------------------------------------------------------

import type { Step } from "./types";
import type { GateQuestionService } from "./executor-types.js";
import { Log } from "../../infra/log";

const log = Log.create({ service: "step-executor" });

// ---------------------------------------------------------------------------
// Gate step constants
// ---------------------------------------------------------------------------

const GATE_CONTINUE = "Continue";
const GATE_STOP = "Stop";
const GATE_PAUSE = "Pause";

// ---------------------------------------------------------------------------
// Gate decision type
// ---------------------------------------------------------------------------

export type GateDecision = "continue" | "stop" | "pause";

// ---------------------------------------------------------------------------
// handleGateStep
// ---------------------------------------------------------------------------

/**
 * Handle a gate step: pause execution and present a question to the user
 * via QuestionService (continue/stop/pause).
 *
 * Returns:
 *   "continue" — mark step completed, advance cursor
 *   "stop"     — mark step failed, stop queue
 *   "pause"    — mark step completed, request shutdown
 *
 * When no QuestionService is provided, auto-resolves as "continue".
 */
export async function handleGateStep(
  step: Step,
  questionService: GateQuestionService | null | undefined,
): Promise<GateDecision> {
  if (!questionService) {
    log.info("gate step auto-resolved (no question service)", { stepId: step.id });
    return "continue";
  }

  try {
    const answers = await questionService.ask([{
      question: step.title || "Approval gate",
      header: "Gate",
      options: [
        { label: GATE_CONTINUE, description: "Continue to next step" },
        { label: GATE_STOP, description: "Stop execution" },
        { label: GATE_PAUSE, description: "Pause execution (can resume later)" },
      ],
    }]);

    const answer = answers?.[0]?.[0] ?? GATE_CONTINUE;

    if (answer === GATE_STOP) return "stop";
    if (answer === GATE_PAUSE) return "pause";
    return "continue";
  } catch {
    log.info("gate step dismissed by user", { stepId: step.id });
    return "stop";
  }
}
